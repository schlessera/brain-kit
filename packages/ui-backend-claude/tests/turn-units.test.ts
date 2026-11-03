/**
 * Direct tests for the units split out of the Claude backend's startTurn
 * (#1360): the turn's terminal state, its runtime and limit reporting, the
 * host inference relay's transport qualification, the prompt gate's check
 * and the stream loop. The whole-turn behaviour stays covered by the
 * backend contract and characterization suites.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendActivityEvent, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { WorkerHostError, type WorkerLimitReport } from "@schlessera/brain-ui-sdk/internal";

import { DEFAULT_PROFILES, type InferenceProfile } from "../src/profiles";
import { StreamAdapter } from "../src/stream-adapter";
import { createTurnInput } from "../src/turn-input";
import { TurnInferenceRelay, hostLoginFile, sameRoute } from "../src/turn-inference-relay";
import { promptGateCheck } from "../src/turn-prompt-gate";
import { WorkerLimitReporter, reportTurnRuntime } from "../src/turn-reporting";
import { runTurnStream, type TurnStreamInputs } from "../src/turn-stream";
import { TurnFailureEscape, TurnFrames, TurnTerminal, thrownTurnFailure, type ResultFrame } from "../src/turn-terminal";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "turn-units-"));
  temps.push(dir);
  return dir;
}

function bridge() {
  const frames: ServerMessage[] = [];
  const activity: BackendActivityEvent[] = [];
  return { frames, activity, bridge: { emit: (msg: ServerMessage) => frames.push(msg), activity: (event: BackendActivityEvent) => activity.push(event) } as unknown as StartTurnRequest["bridge"] };
}

function terminalFixture(sessionId: string | null = "s1") {
  const sink = bridge();
  const host = new AbortController();
  const abortController = new AbortController();
  const frames = new TurnFrames(sink.bridge, sessionId);
  const terminal = new TurnTerminal({ frames, hostSignal: host.signal, abortController, startedAt: Date.now(), pendingFailure: () => null });
  return { ...sink, host, abortController, frames: sink.frames, scoped: frames, terminal };
}

const result = (extra: Partial<ResultFrame> = {}): ResultFrame =>
  ({ type: "result", sessionId: "s1", outcome: "success", durationMs: 5, numTurns: 1, isError: false, ...extra }) as ResultFrame;

describe("TurnFrames", () => {
  test("scopes frames once the session is known and attaches the state room to a result", () => {
    const sink = bridge();
    const frames = new TurnFrames(sink.bridge, null);
    frames.stateRoom = () => ({ observed: true }) as never;
    frames.emit({ type: "status", status: "thinking" } as ServerMessage);
    frames.sessionId = "s1";
    frames.emit(result());
    frames.emit(result({ failure: { errorClass: "session_too_large", message: "x" } } as Partial<ResultFrame>));
    expect(sink.frames[0]).toEqual({ type: "status", status: "thinking" } as ServerMessage);
    expect(sink.frames[1]).toMatchObject({ sessionId: "s1", stateRoom: { observed: true } });
    expect(sink.frames[2]).not.toHaveProperty("stateRoom");
  });
});

describe("TurnTerminal", () => {
  test("a held result is released once, only after the worker has finished", async () => {
    const { terminal, frames } = terminalFixture();
    const order: string[] = [];
    terminal.worker = { finishWorker: async () => { order.push("finished"); } };
    terminal.hold(result());
    expect(terminal.sawResult).toBe(true);
    const releasing = terminal.release();
    expect(frames).toHaveLength(0);
    await releasing;
    order.push(`emitted:${frames.length}`);
    await terminal.release();
    expect(order).toEqual(["finished", "emitted:1"]);
    expect(frames).toEqual([result()]);
  });

  test("a cancellation during the worker's exit keeps the accounting but drops error fields", async () => {
    const { terminal, frames, host } = terminalFixture();
    terminal.worker = { finishWorker: async () => { host.abort(); } };
    terminal.hold(result({ outcome: "error", isError: true, failure: { errorClass: "api_error", message: "x" } } as Partial<ResultFrame>));
    await terminal.release();
    expect(frames).toEqual([
      { type: "status", status: "cancelled", sessionId: "s1" },
      { type: "result", sessionId: "s1", outcome: "cancelled", durationMs: 5, numTurns: 1, isError: false },
    ] as ServerMessage[]);
  });

  test("a refusal's own internal abort is not a cancellation", () => {
    const { terminal, abortController } = terminalFixture();
    terminal.refused = { code: "CLAUDE_AUTH", message: "no" };
    expect(terminal.withhold()).toBe(false);
    expect(terminal.withheld).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(terminal.wasCancelled()).toBe(false);
  });

  test("without a session the generated terminal is a bare error", async () => {
    const { terminal, frames } = terminalFixture(null);
    await terminal.emitGenerated("error");
    await terminal.emitGenerated("error");
    expect(frames).toEqual([{ type: "error", code: "CLAUDE_ERROR", message: "Turn failed before the session was established" }] as ServerMessage[]);
  });

  test("with a session a refusal is a diagnostic error followed by a result carrying its failure", async () => {
    const { terminal, frames } = terminalFixture();
    const failure = { errorClass: "subscription_required", message: "sub" } as const;
    terminal.refused = { code: "CLAUDE_AUTH", message: "sub", failure };
    await terminal.endUnfinished(() => { throw new Error("fallback must not run for a refusal"); });
    expect(frames[0]).toEqual({ type: "error", code: "CLAUDE_AUTH", message: "sub", sessionId: "s1" } as ServerMessage);
    expect(frames[1]).toMatchObject({ type: "result", outcome: "error", isError: true, numTurns: 0, failure });
  });

  test("an unfinished turn the host aborted ends cancelled, before any worker state failure", async () => {
    const { terminal, frames, abortController } = terminalFixture();
    terminal.worker = { workerFailure: () => ({ errorClass: "worker_state_exceeded", message: "full" }) };
    abortController.abort();
    await terminal.endUnfinished(() => ({}));
    expect(frames.map((frame) => frame.type === "result" ? frame.outcome : frame.type)).toEqual(["status", "cancelled"]);
  });

  test("a worker state failure names an unfinished turn", async () => {
    const { terminal, frames } = terminalFixture();
    terminal.worker = { workerFailure: () => ({ errorClass: "worker_state_exceeded", message: "full" }) };
    await terminal.endUnfinished(() => { throw new Error("fallback must not run for a worker refusal"); });
    expect(frames.at(-1)).toMatchObject({ outcome: "error", failure: { errorClass: "worker_state_exceeded" } });
  });

  test("a full worker state turns a successful result into its named failure", () => {
    const { terminal, frames } = terminalFixture();
    terminal.worker = { workerFailure: () => ({ errorClass: "worker_state_exceeded", message: "full" }) };
    expect(terminal.unsaved(result())).toMatchObject({ outcome: "error", isError: true, failure: { errorClass: "worker_state_exceeded" } });
    expect(frames).toEqual([{ type: "error", code: "CLAUDE_ERROR", message: "full", sessionId: "s1" } as ServerMessage]);
  });

  test("a failure after the result was seen is swallowed and the result released", async () => {
    const { terminal, frames } = terminalFixture();
    terminal.hold(result());
    await terminal.fail(new Error("late"), { failure: async () => { throw new Error("not consulted"); } });
    expect(frames).toEqual([result()]);
  });

  test("a turn whose worker a host limit ended fails with that limit named, not the thrown error", async () => {
    const { terminal, frames } = terminalFixture();
    const failure = { errorClass: "worker_resource_limit", message: "memory limit" } as const;
    await terminal.fail(new Error("process exited"), { failure: async () => ({ code: "WORKER_RESOURCE_LIMIT", message: "memory limit", failure }) });
    expect(frames).toEqual([
      { type: "error", code: "WORKER_RESOURCE_LIMIT", message: "memory limit", sessionId: "s1" },
      expect.objectContaining({ type: "result", outcome: "error", failure }),
    ] as ServerMessage[]);
  });

  test("a thrown worker host error names the turn; anything else is a diagnostic", async () => {
    expect(thrownTurnFailure(new Error("boom"))).toEqual({ diagnostic: { code: "CLAUDE_ERROR", message: "boom" } });
    const hostError = new WorkerHostError("worker_host_unavailable" as never, "no host");
    const named = thrownTurnFailure(hostError);
    expect(named.refusal).toEqual({ code: "CLAUDE_ERROR", message: hostError.message,
      failure: { errorClass: hostError.errorClass, message: hostError.message } });
    const { terminal, frames } = terminalFixture();
    await terminal.fail(new Error("boom"), { failure: async () => null });
    expect(frames).toEqual([
      { type: "error", code: "CLAUDE_ERROR", message: "boom", sessionId: "s1" },
      expect.objectContaining({ type: "result", outcome: "error" }),
    ] as ServerMessage[]);
  });
});

describe("turn reporting", () => {
  test("each limit hit is reported once; a fatal one becomes the turn's failure", async () => {
    const activity: BackendActivityEvent[] = [];
    const limits = new WorkerLimitReporter((event) => activity.push(event));
    expect(await limits.failure()).toBeNull();
    const hit = { resource: "memory", limit: 1, observed: 2 };
    const report = { hits: [hit], fatal: false } as unknown as WorkerLimitReport;
    limits.limits = { current: () => report, settled: async () => ({ ...report, fatal: true }) as WorkerLimitReport };
    limits.reportCurrent();
    limits.reportCurrent();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ kind: "resource_limit", limits: [hit], fatal: false });
    expect(await limits.failure()).toMatchObject({ code: "WORKER_RESOURCE_LIMIT", failure: { errorClass: "worker_resource_limit" } });
    expect(activity.at(-1)).toMatchObject({ kind: "resource_limit", fatal: true });
  });

  test("a profile without its own credential that ran on an API key is a policy violation", () => {
    const activity: BackendActivityEvent[] = [];
    const logs: string[] = [];
    reportTurnRuntime({ profile: { id: "p", billing: "subscription" } as InferenceProfile, log: (_level, message) => logs.push(message),
      reportActivity: (event) => activity.push(event) }, "2.0.0", "ANTHROPIC_API_KEY", undefined);
    expect(logs).toEqual(["billing policy violated"]);
    expect(activity[0]).toMatchObject({ kind: "runtime_observed", billing: "api", policy: "subscription",
      policyViolation: "a profile without its own credential ran on an API credential" });
  });
});

describe("TurnInferenceRelay", () => {
  function relayFor(env: Record<string, string | undefined> = {}) {
    const config = tempDir();
    const req = { workerSandbox: { egress: { dir: tempDir() } } } as unknown as StartTurnRequest;
    const profile = { ...DEFAULT_PROFILES[0]!, billing: "subscription" } as InferenceProfile;
    return new TurnInferenceRelay({ req, profile, turnEnvironment: { CLAUDE_CONFIG_DIR: config, ...env }, brainPath: tempDir() });
  }
  const qualified = (baseUrl: string) => ({
    sources: [{ source: "flagSettings", settings: { env: { ANTHROPIC_BASE_URL: baseUrl } } }],
    effective: { env: { ANTHROPIC_BASE_URL: baseUrl } },
  });

  test("a turn without prepared egress runs no relay", () => {
    const relay = new TurnInferenceRelay({ req: {} as StartTurnRequest, profile: DEFAULT_PROFILES[0]!, turnEnvironment: undefined, brainPath: tempDir() });
    expect(relay.egress).toBeUndefined();
    expect(relay.hostLogin).toBeUndefined();
    relay.start();
    expect(relay.stop()).toBeUndefined();
  });

  test("qualifies only the relay's own route, and authorizes nothing before that", () => {
    const relay = relayFor();
    expect(relay.selectedUpstream).toBe("https://api.anthropic.com");
    expect(relay.qualify(undefined, true, undefined)).toBe("the native inference settings sources are not qualified for this prepared transport");
    expect(relay.qualify({ sources: [{ source: "userSettings" }] }, true, undefined)).toBe("the native inference settings sources are not qualified for this prepared transport");
    expect(relay.qualify(qualified("https://elsewhere.example"), true, undefined)).toBe("the native inference source selects a destination not qualified for this prepared transport");
    expect(relay.qualify({ sources: [], effective: { env: {} } }, true, undefined)).toBe("native settings refused the prepared inference transport");
    expect(relay.qualify(qualified(relay.baseUrl), true, undefined)).toBeUndefined();
  });

  test("an unlisted custom origin is refused before the host login", () => {
    const relay = relayFor({ ANTHROPIC_BASE_URL: "https://gateway.example/v1" });
    expect(relay.qualify(qualified(relay.baseUrl), true, undefined)).toBe("the selected inference origin is not authorized to receive the host Claude login; list its exact origin in BRAIN_UI_CLAUDE_OAUTH_ORIGINS");
  });

  test("changed native route inputs refuse the transport first", () => {
    const relay = relayFor();
    relay.routeInputs = { assertUnchanged: () => { throw new Error("changed"); }, close: async () => {} } as never;
    expect(relay.qualify(qualified(relay.baseUrl), true, undefined)).toBe("native inference settings changed during startup");
  });

  test("a route comparison ignores trailing slashes but nothing else", () => {
    expect(sameRoute("https://gateway.example/v1/", "https://gateway.example/v1")).toBe(true);
    expect(sameRoute("https://user@gateway.example/v1", "https://gateway.example/v1")).toBe(false);
    expect(sameRoute("https://gateway.example/v2", "https://gateway.example/v1")).toBe(false);
    expect(hostLoginFile(tempDir(), tempDir())).toEqual({ mask: [], inBrain: false });
  });
});

describe("promptGateCheck", () => {
  function gate(overrides: { account?: unknown; initialize?: () => Promise<unknown> } = {}) {
    const { terminal, abortController } = terminalFixture();
    const activity: BackendActivityEvent[] = [];
    const reported: unknown[] = [];
    const check = promptGateCheck({
      queryHandle: Promise.resolve({} as Query),
      initialize: (overrides.initialize ?? (async () => ({ account: overrides.account }))) as never,
      sdkTurn: { subscriptionOnly: true },
      relay: undefined,
      terminal,
      runtimeRequirements: [],
      phase: "start before prompt release",
      abortController,
      profileId: "default",
      log: () => {},
      reportActivity: (event) => activity.push(event),
      reportRuntime: (...args) => reported.push(args),
    });
    return { check, terminal, abortController, activity, reported };
  }

  test("a subscription turn the CLI would bill elsewhere is refused and withheld", async () => {
    const { check, terminal, abortController, activity, reported } = gate({ account: undefined });
    expect(await check()).toBe(false);
    expect(terminal.refused).toMatchObject({ code: "CLAUDE_AUTH", failure: { errorClass: "subscription_required" } });
    expect(terminal.withheld).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(activity).toMatchObject([{ kind: "auth_failure", errorClass: "subscription_required" }]);
    expect(reported).toHaveLength(1);
  });

  test("a handshake failure refuses the turn, unless the host cancelled it", async () => {
    const failed = gate({ initialize: async () => { throw new Error("no handshake"); } });
    expect(await failed.check()).toBe(false);
    expect(failed.terminal.refused?.message).toContain("Claude Code did not complete its handshake: no handshake");

    const cancelled = gate({ initialize: async () => { cancelled.abortController.abort(); throw new Error("aborted"); } });
    expect(await cancelled.check()).toBe(false);
    expect(cancelled.terminal.refused).toBeNull();
    expect(cancelled.terminal.withheld).toBe(true);
  });
});

describe("runTurnStream", () => {
  function streamOf(messages: unknown[], thrown?: Error): AsyncIterable<SDKMessage> {
    return (async function* () {
      for (const message of messages) yield message as SDKMessage;
      if (thrown) throw thrown;
    })();
  }
  function run(messages: unknown[], options: { thrown?: Error; sessionId?: string; frames?: ServerMessage[] } = {}) {
    const sink = bridge();
    const abortController = new AbortController();
    const frames = new TurnFrames(sink.bridge, options.sessionId ?? null);
    const terminal = new TurnTerminal({ frames, hostSignal: new AbortController().signal, abortController, startedAt: Date.now(), pendingFailure: () => null });
    const adopted: string[] = [];
    const inputs: TurnStreamInputs = {
      stream: streamOf(messages, options.thrown),
      input: createTurnInput("hello"),
      adapter: new StreamAdapter(undefined, { subscriptionAuth: true }),
      frames, terminal, req: { sessionId: options.sessionId }, backendId: "claude", profileId: "default",
      account: Promise.resolve(undefined), reportActivity: () => {}, reportRuntime: () => {},
      runtimeRequirements: [], probedVersion: undefined,
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool: () => {}, close: () => {} },
      limits: new WorkerLimitReporter(() => {}), observeAnswerText: undefined, abortController, ackGrace: {},
      adoptSessionId: (id) => adopted.push(id),
    };
    return { done: runTurnStream(inputs), frames: sink.frames, adopted, terminal };
  }
  const sdkResult = { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0.01, duration_ms: 5, num_turns: 1,
    is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} };

  test("announces a new session, adopts its id and ends on exactly one result", async () => {
    const turn = run([{ type: "system", subtype: "init", session_id: "s1" }, sdkResult, { ...sdkResult, duration_ms: 9 }]);
    await turn.done;
    expect(turn.adopted).toEqual(["s1"]);
    expect(turn.frames[0]).toMatchObject({ type: "session_info", sessionId: "s1", isNew: true });
    expect(turn.frames.filter((frame) => frame.type === "result")).toHaveLength(1);
    expect(turn.frames.at(-1)).toMatchObject({ type: "result", durationMs: 5 });
  });

  test("a stream that ends without a result fails the turn", async () => {
    const turn = run([{ type: "system", subtype: "init", session_id: "s1" }]);
    await turn.done;
    expect(turn.frames.slice(-2)).toMatchObject([
      { type: "error", code: "CLAUDE_NO_RESULT" },
      { type: "result", outcome: "error" },
    ]);
  });

  test("a stream that throws is failed in place; one that throws after its result keeps it", async () => {
    const thrown = run([{ type: "system", subtype: "init", session_id: "s1" }], { thrown: new Error("broken pipe") });
    await thrown.done;
    expect(thrown.frames.slice(-2)).toMatchObject([{ type: "error", message: "broken pipe" }, { type: "result", outcome: "error" }]);

    const late = run([{ type: "system", subtype: "init", session_id: "s1" }, sdkResult], { thrown: new Error("late") });
    await late.done;
    expect(late.frames.at(-1)).toMatchObject({ type: "result", outcome: "success" });
    expect(late.frames.some((frame) => frame.type === "error")).toBe(false);
  });

  test("a failure of the failure handling escapes once, marked", async () => {
    const turn = run([], { thrown: new Error("broken") });
    turn.terminal.fail = async () => { throw new Error("handler failed"); };
    const escaped = await turn.done.then(() => undefined, (error: unknown) => error);
    expect(escaped).toBeInstanceOf(TurnFailureEscape);
    expect((escaped as TurnFailureEscape).cause).toEqual(new Error("handler failed"));
  });
});
