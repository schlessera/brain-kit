/** Real subprocess regressions for the five-second boot deadline (#286). */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudeRuntime } from "../../ui-backend-claude/src/runtime-probe";
import { probeBrainCliVersion } from "../src/brain/client";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createRecordingObservability } from "../src/observability";

const dirs: string[] = [];
const inheritedDirs = new Set<string>();
afterEach(async () => {
  const errors: unknown[] = [];
  for (const dir of dirs.splice(0)) {
    try {
      if (inheritedDirs.delete(dir)) await cleanupDescendant(dir);
    } catch (error) { errors.push(error); }
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
  if (errors.length) throw new AggregateError(errors, "Inherited-pipe fixture cleanup failed");
});

function descendantPid(dir: string): number {
  // Independent cleanup receipt: even a missing/wrong primary marker must not
  // prevent teardown from finding the child whose publication assertion failed.
  const pid = Number(readFileSync(join(dir, "descendant.owner.pid"), "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
  return pid;
}
function inheritedEndpoints(dir: string, pid: number): void {
  for (const fd of [1, 2]) {
    const original = readFileSync(join(dir, `${fd}.endpoint`), "utf8").trim();
    expect(original).toMatch(/^(pipe|socket):\[\d+\]$/);
    expect(readlinkSync(`/proc/${pid}/fd/${fd}`)).toBe(original);
  }
}
async function cleanupDescendant(dir: string): Promise<void> {
  const pid = descendantPid(dir);
  const entry = `/proc/${pid}`;
  if (existsSync(entry)) {
    // Identify the actual inherited endpoints before signalling a non-child PID.
    inheritedEndpoints(dir, pid);
    process.kill(pid, "SIGKILL");
  }
  const until = performance.now() + 1_000;
  while (existsSync(entry) && performance.now() < until) await Bun.sleep(10);
  // This observes non-child disappearance; it is not a direct-child wait/reap.
  expect(existsSync(entry), "owned inherited-pipe descendant disappears after teardown").toBe(false);
}

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function fixture(output: string, body: string | ((dir: string) => string) = 'exec sleep 8') {
  const dir = mkdtempSync(join(tmpdir(), "boot-deadline-"));
  dirs.push(dir);
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const path = executable(join(bin, "brain"), `echo $$ > '${dir}/probe.pid'\nprintf '%s\\n' \"$@\" > '${dir}/argv.log'\ntrap '' TERM\necho '${output}'\n${typeof body === "function" ? body(dir) : body}`);
  const wrapper = executable(join(dir, "wrapper"), 'exec "$@"');
  return { dir, path, wrapper } as { dir: string; path: string; wrapper?: string };
}
async function probe(kind: "brain" | "claude", f: ReturnType<typeof fixture>, killer?: string) {
  const observability = createRecordingObservability();
  let error: unknown;
  const started = performance.now();
  try {
    // The host path of the probe, which a server takes where no governed turn can run (#1648).
    if (kind === "brain") await probeBrainCliVersion(f.dir, observability.logger("brain"), { exec: { wrapper: f.wrapper, killer },
      boundary: createHostBoundary({ brainPath: f.dir, exec: { wrapper: f.wrapper, killer }, workerHost: () => ({ ok: false, requirement: "host-path fixture" }) }) });
    else await probeClaudeRuntime({ claudeCodePath: f.path, brainPath: f.dir, env: { PATH: process.env.PATH }, exec: { wrapper: f.wrapper, killer } });
  } catch (caught) { error = caught; }
  return { elapsed: performance.now() - started, error, logs: observability.logs.find({ severity: "WARN" }) };
}

// 1.5 s permits loaded CI scheduling, not the fixture's eight-second lifetime.
const SETTLEMENT_MARGIN_MS = 1_500;
describe("boot probe deadline", () => {
  test("brain rejects a printed version when a TERM-ignoring command outlives its deadline", async () => {
    const f = fixture("0.42.0");
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
        const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)");
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
          const until = performance.now() + 500;
          let alive = true;
          while (alive && performance.now() < until) {
            try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
          }
          expect(alive).toBe(false);
        }
      });
    }
    test(`${kind} bounds inherited output pipes after the probe process exits`, async () => {
      const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)", dir =>
        `stdout_endpoint=$(readlink /proc/$$/fd/1)\nstderr_endpoint=$(readlink /proc/$$/fd/2)\nprintf '%s\\n' \"$stdout_endpoint\" > '${dir}/1.endpoint'\nprintf '%s\\n' \"$stderr_endpoint\" > '${dir}/2.endpoint'\nsleep 8 &\necho $! > '${dir}/descendant.owner.pid'\necho $! > '${dir}/descendant.pid'\nexit 0`);
      inheritedDirs.add(f.dir);
      delete f.wrapper;
      const result = await probe(kind, f);
      const pid = descendantPid(f.dir);
      const parent = Number(readFileSync(join(f.dir, "probe.pid"), "utf8"));
      expect(existsSync(`/proc/${parent}`), "the original probe parent has exited").toBe(false);
      inheritedEndpoints(f.dir, pid);
      expect(existsSync(join(f.dir, "descendant.pid")), "the descendant publishes its fixture-owned PID marker").toBe(true);
      expect(Number(readFileSync(join(f.dir, "descendant.pid"), "utf8"))).toBe(pid);
      const text = kind === "brain" ? result.logs.map(log => String(log.body)).join("\n") : String(result.error);
      expect(result.elapsed).toBeGreaterThanOrEqual(4_950);
      expect(result.elapsed).toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
      expect(text).toContain("within 5 s");
      expect(text).toContain("Giving up waiting");
    });
    test(`${kind} calls the group killer at the deadline while the probe is alive`, async () => {
      const f = fixture(kind === "brain" ? "0.42.0" : "2.0.0 (Claude Code)");
      const killer = executable(join(f.dir, "killer"), `state=dead\nkill -0 "$1" 2>/dev/null && state=alive\necho "$1 $2 $state" > '${f.dir}/killer.log'\nkill -"$2" -"$1"`);
      const result = await probe(kind, f, killer);
      const pid = readFileSync(join(f.dir, "probe.pid"), "utf8").trim();
      const record = join(f.dir, "killer.log");
      const until = performance.now() + 500;
      while (!existsSync(record) && performance.now() < until) await Bun.sleep(10);
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

// Move only the timestamp source: native timers, IO, signals and five-second
// deadlines remain untouched in these controls.
for (const [direction, shift] of [["forward", 20_000], ["backward", -20_000]] as const) {
  test(`native probe elapsed survives a ${direction} wall-clock jump`, async () => {
    const f = fixture("0.42.0");
    delete f.wrapper;
    const dateDescriptor = Object.getOwnPropertyDescriptor(Date, "now")!;
    const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!;
    const nativeNow = Date.now;
    const nativeSpawn = Bun.spawn;
    let offset = 0;
    let target: Bun.Subprocess | undefined;
    let work: ReturnType<typeof probe> | undefined;
    try {
      Object.defineProperty(Date, "now", { ...dateDescriptor, value: () => nativeNow() + offset });
      Object.defineProperty(Bun, "spawn", { ...spawnDescriptor, value: ((...args: Parameters<typeof Bun.spawn>) => {
        const proc = Reflect.apply(nativeSpawn, Bun, args) as Bun.Subprocess;
        if (args[0].includes(f.path)) target = proc;
        return proc;
      }) as typeof Bun.spawn });
      work = probe("brain", f);
      const until = performance.now() + 2_000;
      let ready = false;
      while (!ready && performance.now() < until) {
        try { ready = !!target && readlinkSync(`/proc/${target.pid}/exe`).endsWith("/sleep"); } catch { /* Await native exec. */ }
        if (!ready) await Bun.sleep(1);
      }
      expect(ready, "native target completed its TERM trap and version output before the jump").toBe(true);
      expect(Number(readFileSync(join(f.dir, "probe.pid"), "utf8"))).toBe(target!.pid);
      offset = shift;
      expect(Math.abs(Date.now() - nativeNow()), "the timestamp really jumped").toBeGreaterThanOrEqual(19_000);
      expect(Math.sign(Date.now() - nativeNow())).toBe(Math.sign(shift));
      const result = await work;
      expect(result.logs.map(log => String(log.body)).join("\n")).toContain("within 5 s");
      expect(result.elapsed, "native elapsed retains its lower bound despite wall-clock adjustment").toBeGreaterThanOrEqual(4_950);
      expect(result.elapsed, "native elapsed retains its upper bound despite wall-clock adjustment").toBeLessThan(5_000 + SETTLEMENT_MARGIN_MS);
    } finally {
      try {
        if (target) {
          if (target.exitCode === null) { try { target.kill("SIGKILL"); } catch { /* Already exited. */ } }
          await target.exited;
        }
        await work?.catch(() => {});
        if (target) expect(existsSync(`/proc/${target.pid}`), "owned direct child disappears after awaited exit").toBe(false);
      } finally {
        // A failed elapsed or disappearance assertion cannot retain either patch.
        try { Object.defineProperty(Date, "now", dateDescriptor); }
        finally { Object.defineProperty(Bun, "spawn", spawnDescriptor); }
        expect(Object.getOwnPropertyDescriptor(Date, "now")).toEqual(dateDescriptor);
        expect(Object.getOwnPropertyDescriptor(Bun, "spawn")).toEqual(spawnDescriptor);
      }
    }
  });
}
