/** Real subprocess regressions for the five-second boot deadline (#286). */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeRuntime } from "../../ui-backend-claude/src/runtime-probe";
import { probeBrainCliVersion } from "../src/brain/client";
import { createRecordingObservability } from "../src/observability";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (const name of ["probe.pid", "descendant.pid", "helper.pid"]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const pid = Number(readFileSync(path, "utf8"));
      if (!(pid > 0)) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* Possibly not a group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function fixture(output: string, body = 'exec sleep 8') {
  const dir = mkdtempSync(join(tmpdir(), "boot-deadline-"));
  dirs.push(dir);
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const path = executable(join(bin, "brain"), `echo $$ > '${dir}/probe.pid'\nprintf '%s\\n' \"$@\" > '${dir}/argv.log'\ntrap '' TERM\necho '${output}'\n${body}`);
  const wrapper = executable(join(dir, "wrapper"), 'exec "$@"');
  return { dir, path, wrapper } as { dir: string; path: string; wrapper?: string };
}
async function probe(kind: "brain" | "claude", f: ReturnType<typeof fixture>, killer?: string) {
  const observability = createRecordingObservability();
  let error: unknown;
  const started = Date.now();
  try {
    if (kind === "brain") await probeBrainCliVersion(f.dir, observability.logger("brain"), { exec: { wrapper: f.wrapper, killer } });
    else await probeClaudeRuntime({ claudeCodePath: f.path, brainPath: f.dir, env: { PATH: process.env.PATH }, exec: { wrapper: f.wrapper, killer } });
  } catch (caught) { error = caught; }
  return { elapsed: Date.now() - started, error, logs: observability.logs.find({ severity: "WARN" }) };
}

// 1.5 s permits loaded CI scheduling, not the fixture's eight-second lifetime.
const SETTLEMENT_MARGIN_MS = 1_500;
describe("boot probe deadline", () => {
  test("brain rejects a printed version when a TERM-ignoring command outlives its deadline", async () => {
    const f = fixture("0.36.0");
    // Also exercise the ordinary, unwrapped CLI launch.
    delete f.wrapper;
    const result = await probe("brain", f);
    expect(result.logs.map(log => String(log.body)).join("\n")).toContain("within 5 s");
    expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
        expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
  });
  for (const kind of ["brain", "claude"] as const) {
    for (const mode of ["missing", "failing", "hung", "noop"] as const) {
      test(`${kind} bounds cleanup with a ${mode} killer`, async () => {
        const f = fixture(kind === "brain" ? "0.36.0" : "2.0.0 (Claude Code)");
        const killer = mode === "missing" ? join(f.dir, "absent") : executable(join(f.dir, "killer"),
          mode === "failing" ? "exit 3" : mode === "noop" ? "exit 0" : `echo $$ > '${f.dir}/helper.pid'\nexec sleep 8`);
        const result = await probe(kind, f, killer);
        expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
        expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
        const text = kind === "brain" ? result.logs.map(log => String(log.body)).join("\n") : String(result.error);
        expect(text).toContain("within 5 s");
        expect(text).toContain(mode === "missing" ? "could not be run" : mode === "failing" ? "exited 3" : mode === "hung" ? "helper cleanup is unconfirmed" : "Giving up waiting");
        if (mode === "noop") {
          const pid = Number(readFileSync(join(f.dir, "probe.pid"), "utf8"));
          // A zero helper exit is not proof that the target stopped.
          expect(() => process.kill(pid, 0)).not.toThrow();
        }
        if (mode === "hung") {
          const pid = Number(readFileSync(join(f.dir, "helper.pid"), "utf8"));
          expect(pid).toBeGreaterThan(0);
          const until = Date.now() + 500;
          let alive = true;
          while (alive && Date.now() < until) {
            try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
          }
          expect(alive).toBe(false);
        }
      });
    }
    test(`${kind} bounds inherited output pipes after the probe process exits`, async () => {
      const f = fixture(kind === "brain" ? "0.36.0" : "2.0.0 (Claude Code)", `sleep 8 &\necho $! > descendant.pid\nexit 0`);
      delete f.wrapper;
      const result = await probe(kind, f);
      const text = kind === "brain" ? result.logs.map(log => String(log.body)).join("\n") : String(result.error);
      expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
      expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
      expect(text).toContain("within 5 s");
      expect(text).toContain("Giving up waiting");
    });
    test(`${kind} calls the group killer at the deadline while the probe is alive`, async () => {
      const f = fixture(kind === "brain" ? "0.36.0" : "2.0.0 (Claude Code)");
      const killer = executable(join(f.dir, "killer"), `state=dead\nkill -0 "$1" 2>/dev/null && state=alive\necho "$1 $2 $state" > '${f.dir}/killer.log'\nkill -"$2" -"$1"`);
      const result = await probe(kind, f, killer);
      const pid = readFileSync(join(f.dir, "probe.pid"), "utf8").trim();
      const record = join(f.dir, "killer.log");
      const until = Date.now() + 500;
      while (!existsSync(record) && Date.now() < until) await Bun.sleep(10);
      expect(existsSync(record)).toBe(true);
      expect(readFileSync(record, "utf8").trim()).toBe(`${pid} KILL alive`);
      expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
        expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
      expect(readFileSync(join(f.dir, "argv.log"), "utf8").trim().split("\n")).toEqual(["--version"]);
      if (kind === "claude") expect(String(result.error)).toContain("within 5 s");
      else expect(result.logs.map(log => String(log.body)).join("\n")).toContain("within 5 s");
    });
  }
});
