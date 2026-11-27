import {
  GMAIL_MESSAGE_BODY_SCHEMA, GOOGLE_DETAIL_ERROR_RESPONSE_SCHEMA,
  type GmailMessageBody, type GoogleToolError,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { BrainUiServices } from "../root.js";

/** How long one detail request may take before it counts as no answer. */
const DETAIL_CALL_TIMEOUT_MS = 20_000;

interface GmailBodyRequest {
  sessionId: string;
  /** The message id a Gmail read result in this session returned. */
  messageId: string;
  signal?: AbortSignal;
}

export type GmailBodyResult = { ok: true; body: GmailMessageBody } | { ok: false; error: GoogleToolError };

const failed = (code: GoogleToolError["code"], reason: string | null, message: string): GmailBodyResult => ({ ok: false, error: { code, reason, message } });

/**
 * One message's full text body (#4207), for the chat's Gmail components
 * (#4210). Display data only: the host never adds it to the conversation, and
 * nothing here writes it anywhere but the caller's own state. Nothing is
 * cached; a card keeps what it loaded for its lifetime. Every failure
 * resolves to the host's typed error, or `upstream_error` with a `host_`
 * reason when the host did not answer with one.
 */
export async function fetchGmailMessageBody(root: Pick<BrainUiServices, "apiBase" | "request">, input: GmailBodyRequest): Promise<GmailBodyResult> {
  if (!GMAIL_MESSAGE_BODY_SCHEMA.shape.message_id.safeParse(input.messageId).success) return failed("invalid_input", "message", "That is not a Gmail message id.");
  const path = [input.sessionId, "google", "gmail", "messages", input.messageId, "body"].map(encodeURIComponent).join("/");
  const timeout = AbortSignal.timeout(DETAIL_CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await root.request(`${root.apiBase()}/sessions/${path}`, { cache: "no-store",
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
  } catch {
    return failed("upstream_error", input.signal?.aborted ? "cancelled" : "host_no_answer", "The host did not answer.");
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const body = GMAIL_MESSAGE_BODY_SCHEMA.safeParse(json);
    if (body.success && body.data.message_id === input.messageId) return { ok: true, body: body.data };
    return failed("upstream_error", "host_malformed", "The host answered with something that is not this message's body.");
  }
  const error = GOOGLE_DETAIL_ERROR_RESPONSE_SCHEMA.safeParse(json);
  if (error.success) return { ok: false, error: error.data.error };
  return failed("upstream_error", `host_http_${response.status}`, `The host could not load this (HTTP ${response.status}).`);
}
