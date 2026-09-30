// A pi turn whose provider call failed ends as a failure (#575). pi does not
// throw for one: `prompt()` resolves and the turn's last assistant message
// has `stopReason: "error"` (pi-coding-agent 0.87.1, `_handlePostAgentRun`).
// The fake session below emits the events the real AgentSession emits for
// that — `message_end`, `auto_retry_start` — through the real turn runner.
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";

import { createPiBackend, type PiSessionLike } from "../src/backend";
import { normalizeMessages, retriedAttempts } from "../src/history";
import { failureFromPiError } from "../src/turn-failure";

const PROVIDER_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"model: unsupported-model-id"}}';

function assistantEnd(stopReason: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stopReason,
      usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      ...extra,
    },
  } as unknown as AgentSessionEvent;
}

const textDelta = (delta: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
  }) as unknown as AgentSessionEvent;

const retryStart = (attempt: number, errorMessage: string) =>
  ({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage }) as AgentSessionEvent;

async function runTurn(events: AgentSessionEvent[]): Promise<ServerMessage[]> {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: PiSessionLike = {
    sessionId: "pi-575",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of events) for (const listener of listeners) listener(event);
    },
    async abort() {},
    getSessionStats: () => ({ cost: 0 }),
    dispose() {},
  };
  const frames: ServerMessage[] = [];
  const backend = createPiBackend({
    brainPath: "/brain",
    sessionFactory: { newSession: async () => session, openSession: async () => session },
  });
  await backend.startTurn({
    prompt: "Test",
    signal: new AbortController().signal,
    bridge: { emit: (frame) => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) },
  });
  return frames;
}

function terminal(frames: ServerMessage[]) {
  const last = frames.at(-1);
  if (last?.type !== "result") throw new Error(`last frame is ${last?.type}`);
  expect(frames.filter((frame) => frame.type === "result")).toHaveLength(1);
  return last;
}

const failureFrames = (frames: ServerMessage[]) =>
  frames.filter((frame) => (frame as { failure?: unknown }).failure !== undefined);

describe("a pi provider failure ends the turn as a failure", () => {
  test("an answer that ended on an error is a failed turn, with the status its text opens with", async () => {
    const frames = await runTurn([assistantEnd("error", { errorMessage: PROVIDER_400 })]);
    const result = terminal(frames);
    expect(result.outcome).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ errorClass: "invalid_request", status: 400, message: PROVIDER_400 });
    expect(failureFrames(frames)).toHaveLength(1);
    // The failed answer's usage is counted once, like any answer's.
    expect(result.usage?.inputTokens).toBe(10);
  });

  test("retries are shown while the turn runs, then the final failure ends it", async () => {
    const frames = await runTurn([
      assistantEnd("error", { errorMessage: "429 rate limited" }),
      retryStart(1, "429 rate limited"),
      assistantEnd("error", { errorMessage: "429 rate limited" }),
      retryStart(2, "429 rate limited"),
      assistantEnd("error", { errorMessage: "429 rate limited" }),
    ]);
    const retries = frames.filter((frame) => frame.type === "status" && frame.retry);
    expect(retries.map((frame) => frame.type === "status" && frame.detail)).toEqual([
      "Retrying (attempt 1 of 3) in 2s after rate_limit, HTTP 429",
      "Retrying (attempt 2 of 3) in 2s after rate_limit, HTTP 429",
    ]);
    const result = terminal(frames);
    expect(frames.indexOf(retries[1]!)).toBeLessThan(frames.indexOf(result));
    expect(result.failure).toEqual({ errorClass: "rate_limit", status: 429, message: "429 rate limited" });
    // Three answers, each counted once.
    expect(result.usage?.inputTokens).toBe(30);
  });

  test("a retry that then answers is a success with no failure", async () => {
    const frames = await runTurn([
      assistantEnd("error", { errorMessage: "529 overloaded" }),
      retryStart(1, "529 overloaded"),
      textDelta("Done."),
      assistantEnd("stop"),
    ]);
    const result = terminal(frames);
    expect(result.outcome).toBe("success");
    expect(result.failure).toBeUndefined();
  });

  test("a partial answer before the failure is still streamed", async () => {
    const frames = await runTurn([textDelta("Half an "), assistantEnd("error", { errorMessage: "connection reset" })]);
    expect(frames.some((frame) => frame.type === "text_delta" && frame.text === "Half an ")).toBe(true);
    const result = terminal(frames);
    // No status in the text: none is claimed.
    expect(result.failure).toEqual({ errorClass: "unknown", message: "connection reset" });
  });
});

describe("failureFromPiError", () => {
  test("reads only a leading status, and only statuses whose meaning is fixed", () => {
    expect(failureFromPiError("401 invalid x-api-key")).toEqual({
      errorClass: "authentication_failed",
      status: 401,
      message: "401 invalid x-api-key",
    });
    expect(failureFromPiError("403: forbidden")).toEqual({ errorClass: "unknown", status: 403, message: "403: forbidden" });
    expect(failureFromPiError("upstream said 500 once")).toEqual({ errorClass: "unknown", message: "upstream said 500 once" });
    expect(failureFromPiError(undefined)).toEqual({ errorClass: "unknown", message: "The model call failed." });
  });
});

describe("pi history keeps the failure", () => {
  const user = { role: "user", content: "Test", timestamp: 1 } as unknown as AgentMessage;
  const failed = {
    role: "assistant",
    content: [{ type: "text", text: "Partial" }],
    stopReason: "error",
    errorMessage: PROVIDER_400,
    model: "m",
    usage: {},
    timestamp: 2,
  } as unknown as AgentMessage;

  test("an answer that ended on an error replays with its failure and its partial text", () => {
    const [, answer] = normalizeMessages([user, failed]);
    expect(answer!.content).toBe("Partial");
    expect(answer!.failure).toEqual({ errorClass: "invalid_request", status: 400, message: PROVIDER_400 });
  });

  test("an attempt pi retried is not replayed as a failure", () => {
    const entry = (id: string, message: AgentMessage) =>
      ({ type: "message", id, parentId: null, timestamp: "t", message }) as unknown as SessionEntry;
    const answered = { ...(failed as object), stopReason: "stop", errorMessage: undefined } as unknown as AgentMessage;
    const branch = [
      entry("u", user),
      entry("a1", failed),
      { type: "context_edit", id: "e1", parentId: "a1", timestamp: "t", targetId: "a1", replacement: null } as unknown as SessionEntry,
      entry("a2", answered),
    ];
    expect([...retriedAttempts(branch)]).toEqual(["a1"]);
  });
});
