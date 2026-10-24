import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
/**
 * A Claude turn claims its session the moment startTurn is called, and only
 * then awaits the per-turn host probe off the event loop (#2790). The claim
 * must hold a follow-up offered meanwhile, a refusal must take it back, and a
 * cancel accepted while the probe runs must still stop the turn. A worker
 * whose deferred probe refuses names the turn's failure as when its spawn
 * threw synchronously.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { prepareWorkerSandbox, workerHostBoundary, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";

mockWorkerHostForSdkStream();

/** A profile with its own key, so no subscription gate runs. */
const profiles = defineProfiles([{ id: "api", label: "API", apiKeyEnv: "TURN_CLAIM_TEST_KEY", source: "declared" }]);
process.env.TURN_CLAIM_TEST_KEY = "sk-ant-api03-test";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function bridge(frames: ServerMessage[]): BackendBridge {
  return { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "allow" }) };
}

test("a probe refusal after the claim rejects, takes the claim back and emits nothing", async () => {
  const pending = deferred<WorkerHostProbe>();
  const probe = spyOn(workerHostBoundary, "probeAsync").mockImplementation(() => pending.promise);
  const prompts: string[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const message of params.prompt) { prompts.push(String(message.message.content)); break; }
      yield { type: "result", subtype: "success", session_id: "voyage", num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {}, is_error: false, result: "done" };
    },
  })) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", profiles, queryFn, log: () => {} });
  const frames: ServerMessage[] = [];
  try {
    const turn = backend.startTurn({ prompt: "Sail past the Sirens.", sessionId: "voyage", signal: new AbortController().signal, bridge: bridge(frames) });
    turn.catch(() => {});
    // Claimed before the probe answered: a second turn on the session is busy.
    const second = backend.startTurn({ prompt: "Again.", sessionId: "voyage", signal: new AbortController().signal, bridge: bridge([]) })
      .then(() => "started", (error: unknown) => (error as Error).message);
    expect(await Promise.race([second, Bun.sleep(1_000).then(() => "waiting on the probe")]), "CLAIM_PRECEDES_PROBE")
      .toContain("already has an active turn");
    pending.resolve({ ok: false, requirement: "bubblewrap is missing" });
    await expect(turn, "PROBE_REFUSAL_REJECTS").rejects.toThrow("bubblewrap is missing");
    expect(frames, "PROBE_REFUSAL_EMITS_NOTHING").toEqual([]);
    expect(prompts).toEqual([]);
    await expect(backend.followUp!({ sessionId: "voyage", prompt: "Mind the Cyclops." }), "PROBE_REFUSAL_RELEASES_CLAIM")
      .rejects.toThrow("No running turn");
  } finally { probe.mockRestore(); }
  // The released session takes a new turn.
  await backend.startTurn({ prompt: "Return to Ithaca.", sessionId: "voyage", signal: new AbortController().signal, bridge: bridge(frames) });
  expect(prompts, "REFUSED_CLAIM_LEFT_NO_TURN_BEHIND").toHaveLength(1);
  expect(prompts[0]).toStartWith("Return to Ithaca.\n");
});

test("a setup refusal after the probe takes the claim back too", async () => {
  const [declared] = profiles;
  const broken = { ...declared!, buildEnv: () => { throw new Error("Odysseus: the profile's environment could not be built"); } };
  const queryFn = (() => { throw new Error("the provider is not reached"); }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", profiles: [broken], queryFn, log: () => {} });
  const frames: ServerMessage[] = [];
  const start = () => backend.startTurn({ prompt: "Sail past the Sirens.", sessionId: "voyage", signal: new AbortController().signal, bridge: bridge(frames) });
  await expect(start()).rejects.toThrow("environment could not be built");
  await expect(backend.followUp!({ sessionId: "voyage", prompt: "Mind the Cyclops." }), "SETUP_REFUSAL_RELEASES_INPUT").rejects.toThrow("No running turn");
  // Not busy: the same refusal again, rather than a stranded claim.
  await expect(start(), "SETUP_REFUSAL_RELEASES_CLAIM").rejects.toThrow("environment could not be built");
  expect(frames).toEqual([]);
});

test("a cancel accepted while the probe runs stops the turn before its prompt reaches the provider", async () => {
  const pending = deferred<WorkerHostProbe>();
  const probe = spyOn(workerHostBoundary, "probeAsync").mockImplementation(() => pending.promise);
  const prompts: string[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: { abortController: AbortController } }) => ({
    async *[Symbol.asyncIterator]() {
      if (params.options.abortController.signal.aborted) throw new Error("aborted before start");
      for await (const message of params.prompt) { prompts.push(String(message.message.content)); break; }
    },
  })) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", profiles, queryFn, log: () => {} });
  const frames: ServerMessage[] = [];
  const controller = new AbortController();
  try {
    const turn = backend.startTurn({ prompt: "Sail past the Sirens.", signal: controller.signal, bridge: bridge(frames) });
    controller.abort();
    pending.resolve({ ok: true });
    await turn;
    expect(prompts, "CANCEL_DURING_PROBE_NEVER_SENDS_PROMPT").toEqual([]);
    expect(frames.filter(frame => frame.type === "status").at(-1), "CANCEL_DURING_PROBE_ENDS_CANCELLED").toMatchObject({ status: "cancelled" });
  } finally { probe.mockRestore(); }
});

test("a worker whose deferred probe refuses names the turn's failure as when its spawn threw", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-turn-claim-"));
  const brain = join(root, "brain"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  // The turn's own probe passes; the spawn's probe, with the worker's allowance, refuses.
  const probe = spyOn(workerHostBoundary, "probeAsync").mockImplementation(async (_brain, options = {}) =>
    options.stateBytes === undefined ? { ok: true } : { ok: false, requirement: "a 64 MiB runtime-state tmpfs" });
  // Like the Agent SDK, report the facade's process error under its own message.
  const queryFn = (({ options }: any) => ({
    initializationResult: async () => ({}),
    async *[Symbol.asyncIterator]() {
      const child = options.spawnClaudeCodeProcess({ command: "/bin/true", args: [], env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: home },
        signal: new AbortController().signal });
      await new Promise((_, reject) => child.once("error", (error: Error) => reject(new Error(`Failed to spawn Claude Code process: ${error.message}`))));
      yield {};
    },
  })) as never;
  const frames: ServerMessage[] = [];
  try {
    const backend = createClaudeBackend({ brainPath: brain, profiles, queryFn, log: () => {} });
    const outcome = await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal,
      workerSandbox: prepareWorkerSandbox(brain, { home, profile: "governed", areas: [] }), bridge: bridge(frames) }).then(() => "resolved", (error: unknown) => error);
    // A start refusal is the turn's terminal error, never a failed worker lifecycle for cleanup to reject on.
    expect(outcome, "DEFERRED_SPAWN_REFUSAL_LEAVES_CLEANUP_CLEAN").toBe("resolved");
    const error = frames.find(frame => frame.type === "error") as Extract<ServerMessage, { type: "error" }> | undefined;
    expect(error?.message, "DEFERRED_SPAWN_REFUSAL_KEEPS_ORIGINAL_ERROR").toStartWith("Agent worker boundary unavailable: a 64 MiB runtime-state tmpfs.");
    expect(error?.failure, "DEFERRED_SPAWN_REFUSAL_KEEPS_FAILURE_CLASS").toEqual({ errorClass: "worker_host_unsupported", message: error!.message });
  } finally { probe.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
