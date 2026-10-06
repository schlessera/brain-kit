// A turn whose model call failed ends on a terminal frame that says so, with
// the failure's class, its status where the runtime stated one, and its text
// (#575). Every case runs the real turn runner and stream adapter against a
// recorded-shape SDK sequence (tests/fixtures/api-failures.ts); nothing here
// needs a key or the network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { SUBSCRIPTION_AUTH_INSTRUCTIONS } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";
import { StreamAdapter } from "../src/stream-adapter";
import {
  INVALID_TOKEN_TEXT,
  NOT_LOGGED_IN_TEXT,
  OVERLOADED_TEXT,
  PARTIAL_ANSWER,
  ERROR_RESULT_THROW,
  SESSION,
  UNSUPPORTED_MODEL_TEXT,
  answered,
  assistantErrorOnly,
  invalidOAuthToken,
  notLoggedIn,
  overloadedMidAnswer,
  unsupportedModel,
  unsupportedModelError,
} from "./fixtures/api-failures";

/** A placeholder key the keyed profile reads; the replayed runtime never sends it. */
const KEY_ENV = "API_FAILURE_TEST_KEY";

const temps: string[] = [];
afterEach(() => {
  delete process.env[KEY_ENV];
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function replay(sequence: SDKMessage[], thenThrow?: string): typeof query {
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield* sequence;
      if (thenThrow) throw new Error(thenThrow);
    })()) as unknown as typeof query;
}

async function runTurn(sequence: SDKMessage[], billing?: "api", thenThrow?: string): Promise<ServerMessage[]> {
  const brainPath = mkdtempSync(join(tmpdir(), "api-failure-"));
  temps.push(brainPath);
  const backend = createClaudeBackend({
    brainPath,
    queryFn: replay(sequence, thenThrow),
    ...(billing
      ? { profiles: defineProfiles([{ id: "keyed", label: "Keyed", model: "claude-opus-5-5", apiKeyEnv: KEY_ENV }]) }
      : {}),
  });
  if (billing) process.env[KEY_ENV] = "placeholder";
  const frames: ServerMessage[] = [];
  await backend.startTurn({
    prompt: "Test",
    signal: new AbortController().signal,
    bridge: { emit: (frame) => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) },
  });
  return frames;
}

/** Every frame that carries a failure, whatever its type. */
const failureFrames = (frames: ServerMessage[]) =>
  frames.filter((frame) => (frame as { failure?: unknown }).failure !== undefined);

function terminal(frames: ServerMessage[]) {
  const last = frames.at(-1);
  expect(last?.type).toBe("result");
  if (last?.type !== "result") throw new Error("no terminal result");
  expect(frames.filter((frame) => frame.type === "result")).toHaveLength(1);
  return last;
}

describe("a failed model call ends the turn as a failure", () => {
  test("a success result with is_error reports the class, status and text, once", async () => {
    const frames = await runTurn(unsupportedModel);
    const result = terminal(frames);
    expect(result.outcome).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.outcomeDetail).toBe("api_error");
    expect(result.failure).toEqual({ errorClass: "invalid_request", status: 400, message: UNSUPPORTED_MODEL_TEXT });
    expect(failureFrames(frames)).toHaveLength(1);
    // The runtime's error text is the failure, not something the model said.
    expect(frames.filter((frame) => frame.type === "text_delta")).toHaveLength(0);
  });

  test("the SDK throwing after its error result, as recorded, adds no frame", async () => {
    const frames = await runTurn(unsupportedModel, undefined, ERROR_RESULT_THROW);
    const result = terminal(frames);
    expect(result.failure).toEqual({ errorClass: "invalid_request", status: 400, message: UNSUPPORTED_MODEL_TEXT });
    expect(frames.filter((frame) => frame.type === "error")).toHaveLength(0);
    expect(failureFrames(frames)).toHaveLength(1);
  });

  test("an auth failure after retries: retries shown live, then the subscription's instruction", async () => {
    const frames = await runTurn(invalidOAuthToken);
    const retries = frames.filter((frame) => frame.type === "status" && frame.retry);
    expect(retries.map((frame) => frame.type === "status" && frame.retry)).toEqual([
      { attempt: 1, maxAttempts: 10, delayMs: 500, errorClass: "authentication_failed", status: 401 },
      { attempt: 2, maxAttempts: 10, delayMs: 1000, errorClass: "authentication_failed", status: 401 },
    ]);
    expect(retries[0]?.type === "status" && retries[0].detail).toBe(
      "Retrying (attempt 1 of 10) in 500ms after authentication_failed, HTTP 401"
    );
    const result = terminal(frames);
    // The retries come before the terminal frame, never after it.
    expect(frames.indexOf(retries[1]!)).toBeLessThan(frames.indexOf(result));
    expect(result.failure).toEqual({
      errorClass: "authentication_failed",
      status: 401,
      message: INVALID_TOKEN_TEXT,
      authAction: "relogin",
      attempts: 2,
    });
    expect(failureFrames(frames)).toHaveLength(1);
  });

  test("a rejected subscription limit keeps its reported reset as epoch milliseconds", async () => {
    const seconds = 1_790_848_800;
    const event = { type: "rate_limit_event", session_id: SESSION,
      rate_limit_info: { status: "rejected", resetsAt: seconds } } as unknown as SDKMessage;
    const result = terminal(await runTurn([event, ...assistantErrorOnly]));
    expect(result.failure?.resetsAt).toBe(seconds * 1000);
    expect(result.failure?.attempts).toBeUndefined();
  });

  test("a rejected reset and retries remain on the SDK result when observed after the assistant error", async () => {
    const adapter = new StreamAdapter();
    adapter.adapt(invalidOAuthToken[3]!);
    adapter.adapt(invalidOAuthToken[1]!);
    adapter.adapt(invalidOAuthToken[1]!); // Count reported retries, even when numbering restarts.
    adapter.adapt({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_790_848_800 } } as SDKMessage);
    const result = terminal(adapter.adapt(invalidOAuthToken.at(-1)!));
    expect(result.failure?.attempts).toBe(2);
    expect(result.failure?.resetsAt).toBe(1_790_848_800_000);
  });

  test("a resumed backend does not carry observations into its next turn", async () => {
    const brainPath = mkdtempSync(join(tmpdir(), "retry-observations-")); temps.push(brainPath);
    const sequences = [[{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_790_848_800 } },
      ...invalidOAuthToken], notLoggedIn, answered];
    const queryFn = (() => (async function* () { yield* sequences.shift()!; })()) as unknown as typeof query;
    const backend = createClaudeBackend({ brainPath, queryFn });
    const failures = [];
    for (let i = 0; i < 3; i++) {
      const frames: ServerMessage[] = [];
      await backend.startTurn({ prompt: "Test", ...(i ? { sessionId: SESSION } : {}), signal: new AbortController().signal,
        bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
      failures.push(terminal(frames).failure);
    }
    expect(failures[0]?.attempts).toBe(2);
    expect(failures[0]?.resetsAt).toBe(1_790_848_800_000);
    expect(failures[1]?.message).toBe(NOT_LOGGED_IN_TEXT);
    expect(failures[1]?.attempts).toBeUndefined();
    expect(failures[1]?.resetsAt).toBeUndefined();
    expect(failures[2]).toBeUndefined();
  });

  test("allowed or unreadable reset observations never invent a cooldown", async () => {
    for (const info of [{ status: "allowed", resetsAt: 1_790_848_800 },
      { status: "allowed_warning", resetsAt: 1_790_848_800 }, { status: "rejected" },
      { status: "rejected", resetsAt: "1790848800" }, { status: "rejected", resetsAt: -1 },
      { status: "rejected", resetsAt: Number.MAX_SAFE_INTEGER }]) {
      const event = { type: "rate_limit_event", session_id: SESSION, rate_limit_info: info } as unknown as SDKMessage;
      const result = terminal(await runTurn([event, ...assistantErrorOnly]));
      expect(result.failure?.message).toBe("API Error: 429 Rate limited.");
      expect(result.failure?.resetsAt).toBeUndefined();
    }
  });

  test("retry observations survive a truncated stream and are absent on a later turn", async () => {
    const result = terminal(await runTurn([...invalidOAuthToken.slice(0, -1)]));
    expect(result.failure?.attempts).toBe(2);
    expect(terminal(await runTurn(notLoggedIn)).failure?.attempts).toBeUndefined();
    expect(terminal(await runTurn(answered)).failure).toBeUndefined();
  });

  test("no credential at all: no status is invented", async () => {
    const result = terminal(await runTurn(notLoggedIn));
    expect(result.failure).toEqual({
      errorClass: "authentication_failed",
      message: NOT_LOGGED_IN_TEXT,
      authAction: "relogin",
    });
    expect("status" in result.failure!).toBe(false);
  });

  test("a profile billing its own key gets no subscription instruction", async () => {
    const result = terminal(await runTurn(invalidOAuthToken, "api"));
    expect(result.failure?.errorClass).toBe("authentication_failed");
    expect(result.failure?.authAction).toBeUndefined();
  });

  test("a partial answer survives; the status comes from the result; usage is the result's, once", async () => {
    const frames = await runTurn(overloadedMidAnswer);
    expect(frames.filter((frame) => frame.type === "text_delta").map((frame) => frame.type === "text_delta" && frame.text)).toEqual([
      PARTIAL_ANSWER,
    ]);
    const result = terminal(frames);
    expect(result.failure).toEqual({ errorClass: "server_error", status: 529, message: OVERLOADED_TEXT });
    expect(result.costUsd).toBe(0.0123);
    expect(result.usage?.inputTokens).toBe(1200);
    expect(result.usage?.outputTokens).toBe(40);
    expect(frames.filter((frame) => frame.type === "result" && frame.usage)).toHaveLength(1);
  });

  test("an API-error message with no result still reaches the terminal frame", async () => {
    const frames = await runTurn(assistantErrorOnly);
    const result = terminal(frames);
    expect(result.outcome).toBe("error");
    expect(result.failure).toEqual({ errorClass: "rate_limit", status: 429, message: "API Error: 429 Rate limited." });
    expect(failureFrames(frames)).toHaveLength(1);
  });

  test("an answered turn carries no failure", async () => {
    const result = terminal(await runTurn(answered));
    expect(result.outcome).toBe("success");
    expect(result.failure).toBeUndefined();
  });
});

describe("StreamAdapter failure detection", () => {
  const result = (fields: Record<string, unknown>) =>
    ({ type: "result", session_id: SESSION, duration_ms: 1, num_turns: 1, modelUsage: {}, ...fields }) as unknown as SDKMessage;

  test("an error subtype with no API error before it carries no failure", () => {
    const out = new StreamAdapter().adapt(result({ subtype: "error_max_turns", is_error: true, total_cost_usd: 0 }));
    const frame = out.find((f) => f.type === "result");
    expect(frame?.type === "result" && frame.outcomeDetail).toBe("max_turns");
    expect(frame?.type === "result" && frame.failure).toBeUndefined();
  });

  test("an error subtype after an API error carries that failure", () => {
    const adapter = new StreamAdapter();
    adapter.adapt(unsupportedModelError);
    const out = adapter.adapt(result({ subtype: "error_during_execution", is_error: true, errors: [] }));
    const frame = out.find((f) => f.type === "result");
    expect(frame?.type === "result" && frame.failure).toEqual({
      errorClass: "invalid_request",
      status: 400,
      message: UNSUPPORTED_MODEL_TEXT,
    });
  });

  test("a result with is_error and no API-error message before it: class unknown, text from the result", () => {
    const out = new StreamAdapter().adapt(
      result({ subtype: "success", is_error: true, result: "API Error: 500 boom", api_error_status: 500, total_cost_usd: 0 })
    );
    const frame = out.find((f) => f.type === "result");
    expect(frame?.type === "result" && frame.failure).toEqual({ errorClass: "unknown", status: 500, message: "API Error: 500 boom" });
  });

  test("an account failure gets check_account, never a new token", () => {
    const adapter = new StreamAdapter(undefined, { subscriptionAuth: true });
    adapter.adapt({
      ...(unsupportedModelError as object),
      error: "billing_error",
    } as unknown as SDKMessage);
    const out = adapter.adapt(result({ subtype: "success", is_error: true, result: "x", api_error_status: 402, total_cost_usd: 0 }));
    const frame = out.find((f) => f.type === "result");
    expect(frame?.type === "result" && frame.failure?.authAction).toBe("check_account");
    expect(SUBSCRIPTION_AUTH_INSTRUCTIONS.check_account).not.toContain("setup-token");
  });

  test("a subagent's API error is the parent's to handle", () => {
    const adapter = new StreamAdapter();
    adapter.adapt({ ...(unsupportedModelError as object), parent_tool_use_id: "agent-1" } as unknown as SDKMessage);
    expect(adapter.pendingFailure()).toBeNull();
  });

  test("a retry with no HTTP response states no status", () => {
    const out = new StreamAdapter().adapt({
      type: "system",
      subtype: "api_retry",
      session_id: SESSION,
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 2500,
      error_status: null,
      error: "server_error",
    } as unknown as SDKMessage);
    expect(out).toEqual([
      {
        type: "status",
        status: "thinking",
        detail: "Retrying (attempt 1 of 3) in 2.5s after server_error",
        retry: { attempt: 1, maxAttempts: 3, delayMs: 2500, errorClass: "server_error" },
      },
    ]);
  });
});
