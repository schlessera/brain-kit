/**
 * Claude's per-turn host probe, its own sandbox's scratch check and its
 * worker's probe and launch run the real launcher with the server's event
 * loop free (#2790, #2796). A 1 ms timer cannot fire during synchronous work,
 * so each test counts its ticks while the real worker starts.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { prepareWorkerSandbox, workerHostBoundary, WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createFixtureMaintenanceHost } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";
import { turnEnv } from "../src/sdk-options";
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
  let reached = false, prepared = 0;
  const queryFn = (() => {
    reached = true;
    throw new Error("Odysseus: the provider is not reached in this test");
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles, queryFn, log: () => {} });
    const workerSandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
    const preparations = [spyOn(internal, "prepareWorkerSandbox"), spyOn(internal, "prepareWorkerSandboxAsync")];
    try {
      await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal, workerSandbox,
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
    } finally { for (const spy of preparations) { prepared += spy.mock.calls.length; spy.mockRestore(); } }
    expect(reached, "TURN_REACHED_SDK_AFTER_REAL_PROBE").toBe(true);
    expect(prepared, "SUPPLIED_SANDBOX_NOT_PREPARED_AGAIN").toBe(0);
    expect(probe.seen.calls, "CLAUDE_TURN_PROBE_AWAITED").toBe(1);
    expect(probe.seen.ticks, "CLAUDE_TURN_PROBE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  } finally { probe.restore(); clock.stop(); f.cleanup(); }
});

/** Ticks that fire while one awaited form runs; a synchronous form never calls it, or lets none fire. */
function measured<K extends "requireWorkerHostAsync" | "launchAgentWorkerAsync" | "prepareWorkerSandboxAsync">(name: K, clock: ReturnType<typeof ticker>) {
  const original = internal[name] as (...args: unknown[]) => Promise<unknown>;
  const seen: { calls: number; ticks: number; args?: unknown[]; result?: unknown } = { calls: 0, ticks: 0 };
  const spy = spyOn(internal, name).mockImplementation((async (...args: unknown[]) => {
    seen.calls++; seen.args = args;
    const before = clock.ticks();
    try { return seen.result = await original(...args); } finally { seen.ticks += clock.ticks() - before; }
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

test.skipIf(!native)("a turn abort leaves a running worker to the SDK's own close, as the synchronous spawn did (#2824)", async () => {
  const f = fixture();
  const turn = new AbortController();
  const sandbox = prepareWorkerSandbox(f.brain, { home: f.home, profile: "governed", areas: [] });
  const spawner = createWorkerSpawn(f.brain, {}, turn.signal, undefined, sandbox);
  try {
    // The SDK's close ends the runtime's input and only later signals it: that grace lets the runtime finish its last request.
    const child = spawner.spawn({ command: "/bin/sh", args: ["-c", "echo ready; IFS= read -r line; echo closed-$line"],
      env: { CLAUDE_CONFIG_DIR: f.config, HOME: f.home }, signal: new AbortController().signal } as never);
    let output = "", exited = false;
    const ready = new Promise<void>(resolve => child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("ready")) resolve(); }));
    const exit = new Promise(done => child.once("exit", (code: number | null) => { exited = true; done(code); }));
    await ready;
    turn.abort();
    await Bun.sleep(300);
    expect(exited, "TURN_ABORT_LEAVES_WORKER_TO_SDK_CLOSE").toBe(false);
    child.stdin.end("grace\n");
    expect(await exit).toBe(0);
    expect(output.trim().split("\n")).toEqual(["ready", "closed-grace"]);
  } finally { await spawner.finish().catch(() => {}); f.cleanup(); }
});

// #2796: a host without governed turns supplies no sandbox, so Claude prepares its own.

const unreached = (() => { throw new Error("Odysseus: the provider is not reached in this test"); }) as unknown as typeof query;

function bridge(frames: ServerMessage[] = []): BackendBridge {
  return { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "allow" }) };
}

test.skipIf(!native)("a turn without a host sandbox awaits its own scratch check with the event loop free and resolves the same sandbox", async () => {
  const f = fixture();
  const clock = ticker();
  const maintenance = createFixtureMaintenanceHost(f.brain);
  const prepare = measured("prepareWorkerSandboxAsync", clock);
  const blocking = spyOn(internal, "prepareWorkerSandbox");
  let reached = false;
  const queryFn = ((...args: Parameters<typeof query>) => { reached = true; return (unreached as (...a: unknown[]) => never)(...args); }) as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles, queryFn, maintenance, log: () => {} });
    await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal, bridge: bridge() });
    expect(reached, "TURN_REACHED_SDK_AFTER_OWN_SANDBOX").toBe(true);
    expect(prepare.seen.calls, "CLAUDE_FALLBACK_SANDBOX_AWAITED").toBe(1);
    expect(blocking, "CLAUDE_FALLBACK_SANDBOX_NEVER_BLOCKS").not.toHaveBeenCalled();
    expect(prepare.seen.ticks, "CLAUDE_FALLBACK_SANDBOX_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    // The inputs its options used: the turn environment's home and the backend's maintenance host.
    const inputs = { home: turnEnv(profiles[0]!).HOME, maintenance };
    expect(prepare.seen.args, "CLAUDE_FALLBACK_SANDBOX_SAME_INPUTS").toEqual([f.brain, inputs]);
    blocking.mockRestore();
    expect(prepare.seen.result, "CLAUDE_FALLBACK_SANDBOX_SAME_AREAS").toEqual(prepareWorkerSandbox(f.brain, inputs));
  } finally { blocking.mockRestore(); prepare.restore(); clock.stop(); maintenance.cleanup(); f.cleanup(); }
});

test("a refused fallback sandbox fails the turn by its named refusal and never prepares one synchronously", async () => {
  const f = fixture();
  const probe = spyOn(workerHostBoundary, "probeAsync").mockResolvedValue({ ok: true });
  const prepare = spyOn(internal, "prepareWorkerSandboxAsync").mockRejectedValue(new WorkerHostError("Odysseus: the scratch check could not start"));
  const blocking = spyOn(internal, "prepareWorkerSandbox");
  let reached = false;
  const queryFn = (() => { reached = true; throw new Error("unreachable"); }) as unknown as typeof query;
  const frames: ServerMessage[] = [];
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles, queryFn, log: () => {} });
    const outcome = await backend.startTurn({ prompt: "Return to Ithaca", sessionId: "odysseus-voyage", signal: new AbortController().signal, bridge: bridge(frames) })
      .then(() => "resolved", (error: unknown) => error);
    expect(outcome, "FALLBACK_REFUSAL_IS_THE_TURNS_RESULT").toBe("resolved");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(blocking, "FALLBACK_REFUSAL_NO_UNPREPARED_SANDBOX").not.toHaveBeenCalled();
    expect(reached, "FALLBACK_REFUSAL_NEVER_REACHES_SDK").toBe(false);
    // The turn ends on its result, carrying the refusal's failure.
    const refusal = new WorkerHostError("Odysseus: the scratch check could not start").message;
    const failure = (seen: ServerMessage[]) => seen.flatMap(frame => frame.type === "result" ? [{ outcome: frame.outcome, failure: frame.failure }] : []);
    expect(failure(frames), "FALLBACK_REFUSAL_NAMED").toEqual([{ outcome: "error", failure: { errorClass: "worker_host_unsupported", message: refusal } }]);
    // The claim is released: the session's next turn starts and reaches its own preparation.
    const again: ServerMessage[] = [];
    await backend.startTurn({ prompt: "Return to Ithaca", sessionId: "odysseus-voyage", signal: new AbortController().signal, bridge: bridge(again) });
    expect(prepare, "FALLBACK_REFUSAL_RELEASES_TURN").toHaveBeenCalledTimes(2);
    expect(failure(again), "FALLBACK_REFUSAL_RELEASES_TURN").toEqual(failure(frames));
  } finally { blocking.mockRestore(); prepare.mockRestore(); probe.mockRestore(); f.cleanup(); }
});

test("Claude's own sandbox and its options share one resolved environment, for an ordinary and an unrestricted autonomous turn", async () => {
  const f = fixture();
  let builds = 0;
  // A profile whose environment differs on every resolution: a second one would show.
  const shifting = [{ ...profiles[0]!, buildEnv: () => ({ HOME: `/odysseus/home-${++builds}` }) }];
  const probe = spyOn(workerHostBoundary, "probeAsync").mockResolvedValue({ ok: true });
  const homes: { prepared?: string; sdk?: string }[] = [];
  const prepare = spyOn(internal, "prepareWorkerSandboxAsync").mockImplementation(async (brain, options) => {
    homes.push({ prepared: options?.home });
    return { brain, restricted: false, areas: [], scratchAliasesRemoved: [], home: { mode: "xdg" } };
  });
  const queryFn = (({ options }: Parameters<typeof query>[0]) => {
    homes.at(-1)!.sdk = options?.env?.HOME;
    throw new Error("Odysseus: the provider is not reached in this test");
  }) as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: f.brain, profiles: shifting, queryFn, log: () => {} });
    await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal, bridge: bridge() });
    await backend.startTurn({ prompt: "Summarize the voyage", signal: new AbortController().signal, enforceAllowedTools: true, noGrantSurface: true,
      bridge: { ...bridge(), checkpointPermission: () => {} },
      autonomous: { origin: "autonomous", persistence: "none", allowedTools: [], systemPromptAppend: "Summarize the voyage." } });
    expect(homes, "OWN_SANDBOX_SAME_ENVIRONMENT_AS_OPTIONS").toEqual([
      { prepared: "/odysseus/home-1", sdk: "/odysseus/home-1" }, { prepared: "/odysseus/home-2", sdk: "/odysseus/home-2" }]);
  } finally { prepare.mockRestore(); probe.mockRestore(); f.cleanup(); }
});
