/**
 * Claude's per-turn host probe and its worker's probe and launch run the real
 * launcher with the server's event loop free (#2790). A 1 ms timer cannot
 * fire during synchronous work, so each test counts its ticks while the real
 * worker starts.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import * as internal from "@schlessera/brain-ui-sdk/internal";
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
  const probe = measured("requireWorkerHostAsync", clock);
  let reached = false;
  const queryFn = (() => {
    reached = true;
    throw new Error("Odysseus: the provider is not reached in this test");
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles, queryFn, log: () => {} });
    const workerSandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
    await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal, workerSandbox,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
    expect(reached, "TURN_REACHED_SDK_AFTER_REAL_PROBE").toBe(true);
    expect(probe.seen.calls, "CLAUDE_TURN_PROBE_AWAITED").toBe(1);
    expect(probe.seen.ticks, "CLAUDE_TURN_PROBE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  } finally { probe.restore(); clock.stop(); f.cleanup(); }
});

/** Ticks that fire while one awaited form runs; a synchronous form never calls it, or lets none fire. */
function measured<K extends "requireWorkerHostAsync" | "launchAgentWorkerAsync">(name: K, clock: ReturnType<typeof ticker>) {
  const original = internal[name] as (...args: unknown[]) => Promise<unknown>;
  const seen = { calls: 0, ticks: 0 };
  const spy = spyOn(internal, name).mockImplementation((async (...args: unknown[]) => {
    seen.calls++;
    const before = clock.ticks();
    try { return await original(...args); } finally { seen.ticks += clock.ticks() - before; }
  }) as never);
  return { seen, restore: () => spy.mockRestore() };
}

test.skipIf(!native)("a Claude worker's real probe and launch each run with the event loop free behind the deferred spawn", async () => {
  const f = fixture();
  const clock = ticker();
  const probe = measured("requireWorkerHostAsync", clock), launch = measured("launchAgentWorkerAsync", clock);
  let started = false;
  const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
  const spawner = createWorkerSpawn(f.brain, {}, new AbortController().signal, undefined, sandbox, undefined, undefined, {}, undefined,
    () => { started = true; });
  try {
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", "printf ithaca"], env: { CLAUDE_CONFIG_DIR: f.config, HOME: f.home },
      signal: new AbortController().signal } as never);
    // The SDK's synchronous callback returns before any worker exists.
    expect(started, "SPAWN_RETURNS_BEFORE_WORKER").toBe(false);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stdin.end();
    const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
    await spawner.finish();
    expect(code).toBe(0);
    expect(output, "DEFERRED_WORKER_RUNS_COMMAND").toBe("ithaca");
    expect(probe.seen.calls, "CLAUDE_WORKER_PROBE_AWAITED").toBe(1);
    expect(probe.seen.ticks, "CLAUDE_WORKER_PROBE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(launch.seen.calls, "CLAUDE_WORKER_LAUNCH_AWAITED").toBe(1);
    expect(launch.seen.ticks, "CLAUDE_WORKER_LAUNCH_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  } finally { probe.restore(); launch.restore(); clock.stop(); await spawner.finish().catch(() => {}); f.cleanup(); }
});

test.skipIf(!native)("a started worker's failed lifecycle stays handled until the turn awaits it", async () => {
  const f = fixture();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
  const spawner = createWorkerSpawn(f.brain, {}, new AbortController().signal, undefined, sandbox, undefined, undefined, {}, undefined,
    () => { throw new Error("Odysseus scope freezer refused"); });
  try {
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", "while :; do sleep 1; done"], env: { CLAUDE_CONFIG_DIR: f.config, HOME: f.home },
      signal: new AbortController().signal } as never);
    child.on("error", () => {}); child.stdout.resume(); child.stdin.end();
    await new Promise(done => child.once("exit", done));
    await Bun.sleep(50);
    expect(unhandled, "WORKER_LIFECYCLE_FAILURE_HANDLED_BEFORE_FINISH").toEqual([]);
    await expect(spawner.finish()).rejects.toThrow("scope freezer refused");
  } finally { process.off("unhandledRejection", record); await spawner.finish().catch(() => {}); f.cleanup(); }
});
