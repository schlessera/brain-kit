/** The selected native runtime opens no connection of its own on a relayed turn (#3244), with only loopback available. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKER_EGRESS_DIR } from "@schlessera/brain-ui-sdk/internal";

const root = resolve(import.meta.dir, "../../..");
async function probe(scenario: "plain" | "webfetch") {
  const scratch = mkdtempSync(join(tmpdir(), "relayed-runtime-traffic-"));
  try {
    mkdirSync(join(scratch, "egress"));
    // No test fetch instrumentation covers the native executable, so its
    // whole process tree runs with no external route.
    const child = Bun.spawn(["bwrap", "--unshare-net", "--die-with-parent", "--bind", "/", "/", "--tmpfs", "/run", "--bind", join(scratch, "egress"), WORKER_EGRESS_DIR,
      "--proc", "/proc", "--dev", "/dev", process.execPath, "--preload", join(root, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/relayed-runtime-traffic-probe.ts"), scratch, scenario],
    { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(readFileSync(join(scratch, "result.json"), "utf8")) as {
      result?: string; connections: string[]; relayed: string[];
      env: Record<string, string | undefined>; settings: Record<string, unknown>;
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("a relayed turn's runtime sends only relayed inference: no first-party event logging or feature-flag connection reaches the turn proxy", async () => {
  const observed = await probe("plain");
  expect(observed.result).toBe("success");
  expect(observed.relayed.length, "INFERENCE_GOES_THROUGH_THE_RELAY").toBeGreaterThan(0);
  expect(observed.connections, "RUNTIME_OPENS_NO_CONNECTION_OF_ITS_OWN").toEqual([]);
  expect(observed.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  expect((observed.settings.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "FLAG_SETTINGS_OUTRANK_PROJECT_SETTINGS").toBe("1");
}, 120_000);

test("a relayed turn's WebFetch connects only to the page it fetches, with no vendor domain preflight before it", async () => {
  const observed = await probe("webfetch");
  expect(observed.result).toBe("success");
  expect(observed.connections, "WEBFETCH_REACHES_ONLY_ITS_TARGET").toEqual(["CONNECT ithaca.example:443"]);
  expect(observed.settings.skipWebFetchPreflight).toBe(true);
}, 120_000);
