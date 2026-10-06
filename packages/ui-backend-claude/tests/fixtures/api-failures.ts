/**
 * Claude Agent SDK message sequences for turns whose model call failed
 * (#191, #575). Sanitized and deterministic: ids are fixed placeholders and
 * there is no account, host or token in them.
 *
 * Where the sequences come from:
 *
 * - `invalidOAuthToken` and `notLoggedIn` follow the sequences recorded on
 *   2026-09-23 against Claude Code 2.1.278 and 2.1.280 (#191, comment of that
 *   date): with an invalid `CLAUDE_CODE_OAUTH_TOKEN`, two `api_retry` messages
 *   (`error_status: 401`, `error: "authentication_failed"`), then an
 *   `assistant` message with `error: "authentication_failed"` and the text
 *   below, then a `result` with `subtype: "success"`, `is_error: true` and the
 *   same text. With no credential, no retries and "Not logged in · Please run
 *   /login". The recording did not keep the retries' attempt counts or
 *   delays, or the results' `api_error_status`; the values below for those
 *   are placeholders, and the no-credential result's status is null because
 *   no request was sent.
 * - `unsupportedModel` is the sequence recorded on 2026-10-06 with Agent SDK
 *   0.3.270 (Claude Code 2.1.270) asked for `claude-opus-5-5` on a
 *   subscription (#191): `init`, a `status` of `requesting`, the API-error
 *   `assistant` message (`error: "invalid_request"`,
 *   `api_error: "claude_code_version_too_old"`), then a `result` with
 *   `subtype: "success"`, `is_error: true`, `api_error_status: 400` and
 *   `terminal_reason: "api_error"`. The SDK then threw
 *   "Claude Code returned an error result" from its message iterator. Ids,
 *   the request id and timings are placeholders; the fields kept are the ones
 *   the adapter could read.
 * - `overloadedMidAnswer` is the runtime's own wording for exhausted 529
 *   retries (the `H7` constant in the 2.1.x CLI), after a partial answer.
 *
 * Every shape follows the installed SDK's types (`SDKAssistantMessage`,
 * `SDKAPIRetryMessage`, `SDKResultSuccess` in
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, 0.3.283), and the
 * API-error message itself is shaped the way the runtime builds one: model
 * `<synthetic>`, `stop_reason: "stop_sequence"`, zero usage.
 */
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

export const SESSION = "00000000-0000-4000-8000-000000000575";

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const init = (): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: SESSION }) as unknown as SDKMessage;

const requesting = (): SDKMessage =>
  ({
    type: "system",
    subtype: "status",
    status: "requesting",
    session_id: SESSION,
    uuid: "00000000-0000-4000-8000-00000000c001",
  }) as unknown as SDKMessage;

/** The runtime's API-error message: text only, never streamed as deltas. */
function apiErrorMessage(error: string, text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "assistant",
    session_id: SESSION,
    uuid: "00000000-0000-4000-8000-00000000a001",
    parent_tool_use_id: null,
    error,
    message: {
      id: "00000000-0000-4000-8000-00000000a002",
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: ZERO_USAGE,
    },
    ...extra,
  } as unknown as SDKMessage;
}

/** How the runtime ends a turn on an API error: success subtype, is_error set. */
function errorResult(text: string, apiErrorStatus: number | null, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: SESSION,
    uuid: "00000000-0000-4000-8000-00000000a003",
    is_error: true,
    api_error_status: apiErrorStatus,
    result: text,
    duration_ms: 812,
    duration_api_ms: 640,
    num_turns: 1,
    stop_reason: "stop_sequence",
    total_cost_usd: 0,
    usage: ZERO_USAGE,
    modelUsage: {},
    permission_denials: [],
    ...extra,
  } as unknown as SDKMessage;
}

function retry(attempt: number, delayMs: number, errorStatus: number | null, error: string): SDKMessage {
  return {
    type: "system",
    subtype: "api_retry",
    session_id: SESSION,
    uuid: `00000000-0000-4000-8000-00000000b00${attempt}`,
    attempt,
    max_retries: 10,
    retry_delay_ms: delayMs,
    error_status: errorStatus,
    error,
  } as unknown as SDKMessage;
}

function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    session_id: SESSION,
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

export const UNSUPPORTED_MODEL_TEXT =
  "API Error: 400 Claude Code 2.1.270 does not support this model; version 2.1.280 or newer is required. " +
  "Run 'claude update', or update the Claude desktop app, then try again.";
export const INVALID_TOKEN_TEXT = "Failed to authenticate. API Error: 401 OAuth access token is invalid.";
export const NOT_LOGGED_IN_TEXT = "Not logged in · Please run /login";
export const OVERLOADED_TEXT =
  "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.";
export const PARTIAL_ANSWER = "Here is what I found so far: ";

export const unsupportedModelError: SDKMessage = apiErrorMessage("invalid_request", UNSUPPORTED_MODEL_TEXT, {
  request_id: "req_00000000000000000000191",
  is_api_error_message: true,
  api_error: "claude_code_version_too_old",
});

export const unsupportedModel: SDKMessage[] = [
  init(),
  requesting(),
  unsupportedModelError,
  errorResult(UNSUPPORTED_MODEL_TEXT, 400, { duration_api_ms: 0, terminal_reason: "api_error" }),
];

/** What the recorded SDK's iterator threw after delivering that result. */
export const ERROR_RESULT_THROW = "Claude Code returned an error result: " + UNSUPPORTED_MODEL_TEXT;

export const invalidOAuthToken: SDKMessage[] = [
  init(),
  retry(1, 500, 401, "authentication_failed"),
  retry(2, 1000, 401, "authentication_failed"),
  apiErrorMessage("authentication_failed", INVALID_TOKEN_TEXT),
  errorResult(INVALID_TOKEN_TEXT, 401),
];

export const notLoggedIn: SDKMessage[] = [
  init(),
  apiErrorMessage("authentication_failed", NOT_LOGGED_IN_TEXT),
  errorResult(NOT_LOGGED_IN_TEXT, null),
];

/** A partial answer, then the call fails; the result states the status. */
export const overloadedMidAnswer: SDKMessage[] = [
  init(),
  textDelta(PARTIAL_ANSWER),
  apiErrorMessage("server_error", OVERLOADED_TEXT),
  errorResult(OVERLOADED_TEXT, 529, {
    total_cost_usd: 0.0123,
    usage: { ...ZERO_USAGE, input_tokens: 1200, output_tokens: 40 },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 1200,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0123,
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
    },
  }),
];

/** The API-error message, then the stream ends with no result at all. */
export const assistantErrorOnly: SDKMessage[] = [init(), apiErrorMessage("rate_limit", "API Error: 429 Rate limited.")];

/** An ordinary success, for the guard that nothing else changed. */
export const answered: SDKMessage[] = [
  init(),
  textDelta("Hello."),
  {
    type: "result",
    subtype: "success",
    session_id: SESSION,
    is_error: false,
    result: "Hello.",
    duration_ms: 10,
    duration_api_ms: 8,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage: ZERO_USAGE,
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage,
];

/**
 * The same failures as the SDK's transcript reader returns them on reload:
 * `getSessionMessages` keeps `message` and drops the entry's
 * `isApiErrorMessage` and `error` fields.
 */
export function transcriptEntry(type: "user" | "assistant", message: Record<string, unknown>): SessionMessage {
  return {
    type,
    uuid: `00000000-0000-4000-8000-${String(++transcriptCounter).padStart(12, "0")}`,
    session_id: SESSION,
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
  } as unknown as SessionMessage;
}
let transcriptCounter = 0;

export const userTurn = (text: string) =>
  transcriptEntry("user", { role: "user", content: [{ type: "text", text }] });

export const answerEntry = (text: string) =>
  transcriptEntry("assistant", {
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: null,
  });

export const syntheticEntry = (text: string) =>
  transcriptEntry("assistant", {
    role: "assistant",
    model: "<synthetic>",
    content: [{ type: "text", text }],
    stop_reason: "stop_sequence",
    stop_sequence: "",
    usage: ZERO_USAGE,
  });
