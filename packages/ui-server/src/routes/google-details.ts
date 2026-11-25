import { Hono, type Context } from "hono";
import type { GoogleError, GooglePolicy } from "@schlessera/brain-common/internal/google-operations";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { BRIDGE_MCP_PREFIX, GMAIL_TOOL_NAMES, GOOGLE_RESULT_SCHEMAS, type GoogleErrorCode } from "@schlessera/brain-ui-sdk/tool-contracts";
import { GMAIL_MESSAGE_ID_PATTERN } from "@schlessera/brain-common/internal/google-operations";

import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import type { GoogleToolsHost } from "../google/host.js";

interface GoogleDetailRouteDeps {
  tools: Pick<GoogleToolsHost, "messageBody">;
  /** The brain's current admitted policy's `google` block, read at each request. */
  policy: () => GooglePolicy | null | undefined;
  principalValid: (principal: Principal) => boolean;
  /** Whether the caller is the chat's owner account (any of its logins). */
  owns: (principal: Principal, sessionId: string) => boolean;
  /** Whether the chat is retired (#3230): it has nothing left to show. */
  retired: (sessionId: string) => boolean;
  /** The session's recorded history, as its owning backend replays it. */
  history: (sessionId: string) => Promise<SessionHistoryMessage[]>;
  /** Settles once catalog writes submitted before it have committed. */
  settled?: () => Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const STATUS: Partial<Record<GoogleErrorCode, 400 | 403 | 404 | 429 | 502 | 503>> = {
  invalid_input: 400, policy_denied: 403, forbidden: 403, not_found: 404, rate_limited: 429, upstream_error: 502,
  unavailable: 503, transport_incompatible: 503,
};

const READ_TOOL = new Set<string>([GMAIL_TOOL_NAMES.read, `${BRIDGE_MCP_PREFIX}${GMAIL_TOOL_NAMES.read}`]);

/**
 * The message ids the session's recorded Gmail read results returned, in
 * either view. Only a result that parses as the read tool's own successful
 * envelope counts: an error, a truncated or edited output, or another tool's
 * text names nothing.
 */
function googleSessionMessages(messages: readonly SessionHistoryMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!READ_TOOL.has(call.name) || call.isError || typeof call.output !== "string" || call.output.length > 4_000_000) continue;
      let raw: unknown;
      try { raw = JSON.parse(call.output); } catch { continue; }
      const parsed = GOOGLE_RESULT_SCHEMAS[GMAIL_TOOL_NAMES.read].safeParse(raw);
      if (!parsed.success || !parsed.data.ok) continue;
      const result = parsed.data.result;
      if (result.kind === "thread") for (const item of result.messages) ids.add(item.message_id);
      else if (result.kind === "message") ids.add(result.message.message_id);
      else if (result.kind === "draft" && result.message) ids.add(result.message.message_id);
    }
  }
  return ids;
}

function refuse(c: Context<AppEnv>, error: Pick<GoogleError, "code" | "reason" | "message">) {
  return c.json({ error: { code: error.code, reason: error.reason, message: error.message } }, STATUS[error.code] ?? 502);
}

/**
 * The display-only Gmail detail route (#4207), internal, for the chat's Gmail
 * components: a message's full text body beyond the model's 32 KiB cap.
 * Owner-authenticated and read-only, and never provider context: a response
 * is not added to the conversation, not journaled as turn input, not routed
 * and does not taint the session.
 *
 * - `GET /sessions/:id/google/gmail/messages/:message/body` serves one
 *   message a Gmail read result in that session returned, decided again as
 *   a read under the brain's current policy: the owner only, Google enabled,
 *   and its thread checked against `hidden_labels`, so a thread hidden since
 *   answers `not_found`.
 */
export function createGoogleDetailRoutes(deps: GoogleDetailRouteDeps): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .get("/sessions/:id/google/gmail/messages/:message/body", async (c) => {
      c.header("Cache-Control", "no-store");
      const sessionId = c.req.param("id"), messageId = c.req.param("message");
      const principal = c.get("principal");
      if (!principal || !deps.principalValid(principal)) return c.json({ error: "Authentication required", authRequired: true }, 401);
      if (!SESSION_ID.test(sessionId)) return refuse(c, { code: "invalid_input", reason: "session", message: "That is not a session id." });
      if (!GMAIL_MESSAGE_ID_PATTERN.test(messageId)) return refuse(c, { code: "invalid_input", reason: "message", message: "That is not a Gmail message id." });
      await deps.settled?.();
      if (!deps.owns(principal, sessionId)) return refuse(c, { code: "forbidden", reason: "not_owner", message: "Only the chat's owner can read its Gmail details." });
      if (deps.retired(sessionId)) return refuse(c, { code: "not_found", reason: "not_in_session", message: "This host has no such session." });
      let history: SessionHistoryMessage[];
      try { history = await deps.history(sessionId); }
      catch { return refuse(c, { code: "not_found", reason: "not_in_session", message: "This session's history could not be read." }); }
      // Bounded authority: only a message this session's Gmail results returned.
      if (!googleSessionMessages(history).has(messageId))
        return refuse(c, { code: "not_found", reason: "not_in_session", message: "No Gmail result in this session returned that message." });
      let policy: GooglePolicy | null | undefined;
      try { policy = deps.policy(); } catch { policy = undefined; }
      const read = await deps.tools.messageBody(principal.id, policy, messageId, sessionId);
      if (!deps.principalValid(principal)) return c.json({ error: "Authentication required", authRequired: true }, 401);
      if (!read.ok) return refuse(c, read.error);
      return c.json(read.body);
    });
}
