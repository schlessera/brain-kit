/**
 * Claude's per-turn host probe and its worker's probe and launch run the real
 * launcher with the server's event loop free (#2790). A 1 ms timer cannot
 * fire during synchronous work, so each test counts its ticks while the real
 * worker starts.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";
import { createWorkerSpawn } from "../src/worker-spawn";

const ROOT = resolve(import.meta.dir, "../../..");
const native = process.platform === "linux" && Boolean(Bun.which("bwrap"));
const profiles = defineProfiles([{ id: "api", label: "API", apiKeyEnv: "WORKER_EVENT_LOOP_TEST_KEY", source: "declared" }]);
process.env.WORKER_EVENT_LOOP_TEST_KEY = "sk-ant-api03-test";

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/claude-event-loop-"));
  const brain = join(root, "brain"), home = join(root, "home"), config = join(root, "config");
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(home); mkdirSync(config);
  writeFileSync(join(config, "settings.json"), "{}");
  return { root, brain, home, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function ticker() {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  return { ticks: () => ticks, stop: () => clearInterval(timer) };
}

test.skipIf(!native)("startTurn claims, then awaits its real host probe with the event loop free before the SDK starts", async () => {
  const f = fixture();
  const clock = ticker();
  let atQuery: number | undefined;
  const queryFn = (() => {
    atQuery = clock.ticks();
    throw new Error("Odysseus: the provider is not reached in this test");
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles, queryFn, log: () => {} });
    const workerSandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
    const start = clock.ticks();
    await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal, workerSandbox,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
    expect(atQuery, "TURN_REACHED_SDK_AFTER_REAL_PROBE").toBeDefined();
    expect(atQuery! - start, "CLAUDE_TURN_PROBE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  } finally { clock.stop(); f.cleanup(); }
});

test.skipIf(!native)("a Claude worker's real probe and launch run with the event loop free behind the deferred spawn", async () => {
  const f = fixture();
  const clock = ticker();
  let atStart: number | undefined;
  const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
  const spawner = createWorkerSpawn(f.brain, {}, new AbortController().signal, undefined, sandbox, undefined, undefined, {}, undefined,
    () => { atStart = clock.ticks(); });
  try {
    const start = clock.ticks();
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", "printf ithaca"], env: { CLAUDE_CONFIG_DIR: f.config, HOME: f.home },
      signal: new AbortController().signal } as never);
    // The SDK's synchronous callback returns before any worker exists.
    expect(atStart, "SPAWN_RETURNS_BEFORE_PROBE").toBeUndefined();
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stdin.end();
    const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
    await spawner.finish();
    expect(code).toBe(0);
    expect(output, "DEFERRED_WORKER_RUNS_COMMAND").toBe("ithaca");
    expect(atStart! - start, "CLAUDE_WORKER_START_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  } finally { clock.stop(); await spawner.finish().catch(() => {}); f.cleanup(); }
});
