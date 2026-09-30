import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  API_FAILURE_DETAIL,
  runBackendContract,
  type BackendContractHarness,
  type TurnScript,
} from "@schlessera/brain-ui-sdk/testing";

import { createClaudeBackend } from "../src/backend";

const temps: string[] = [];
function tempBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), "backend-contract-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function claudeScriptedQuery(script: TurnScript): typeof query {
  return ((_params: { prompt: unknown; options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      for (const text of script.textDeltas) {
        yield {
          type: "stream_event",
          session_id: script.sessionId,
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        };
      }
      yield {
        type: "result",
        subtype: "success",
        session_id: script.sessionId,
        total_cost_usd: 0.01,
        duration_ms: 5,
        num_turns: 1,
      };
    })()) as unknown as typeof query;
}

let hangCounter = 0;

/** Emits a session identity, then hangs until the host aborts. */
function claudeHangingQuery(): typeof query {
  return ((params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: `hang-${++hangCounter}` };
      await new Promise<void>((_resolve, reject) => {
        const sig = params.options?.abortController?.signal;
        if (sig?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        sig?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    })()) as unknown as typeof query;
}

/** Emits a session identity, then throws like a provider failure. */
function claudeFailingQuery(script: TurnScript): typeof query {
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      throw new Error("provider exploded");
    })()) as unknown as typeof query;
}

/** Emits a session identity and deltas, then ends WITHOUT a result. */
function claudeTruncatedQuery(script: TurnScript): typeof query {
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      for (const text of script.textDeltas) {
        yield {
          type: "stream_event",
          session_id: script.sessionId,
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        };
      }
    })()) as unknown as typeof query;
}

/**
 * The runtime's API-error path (#575): its API-error message, then a
 * `success` result with `is_error` and the status beside the text.
 */
function claudeApiFailureQuery(script: TurnScript): typeof query {
  const text = `API Error: 400 ${API_FAILURE_DETAIL}`;
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      yield {
        type: "assistant",
        session_id: script.sessionId,
        parent_tool_use_id: null,
        error: "invalid_request",
        message: { model: "<synthetic>", content: [{ type: "text", text }] },
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: script.sessionId,
        is_error: true,
        api_error_status: 400,
        result: text,
        total_cost_usd: 0,
        duration_ms: 5,
        num_turns: 1,
      };
    })()) as unknown as typeof query;
}

/** One `api_retry` (429), then the scripted answer. */
function claudeRetryingQuery(script: TurnScript): typeof query {
  const answer = claudeScriptedQuery(script);
  return ((params: { prompt: unknown; options?: Options }) =>
    (async function* () {
      yield {
        type: "system",
        subtype: "api_retry",
        session_id: script.sessionId,
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 429,
        error: "rate_limit",
      };
      yield* answer(params as never) as AsyncIterable<unknown>;
    })()) as unknown as typeof query;
}

const harness: BackendContractHarness = {
  name: "claude",
  scripted: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeScriptedQuery(script) }),
  hanging: () =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeHangingQuery() }),
  failing: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeFailingQuery(script) }),
  truncated: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeTruncatedQuery(script) }),
  apiFailure: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeApiFailureQuery(script) }),
  retrying: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeRetryingQuery(script) }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });
