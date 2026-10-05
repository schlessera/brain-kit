/**
 * The request id an in-process ask tool hands the host bridge (#910).
 *
 * It is the model's `tool_use` id, so the live card and the card rebuilt
 * from `session_history` (which can only know the tool call's id) are the
 * same request. The pi backend already keys its asks this way.
 *
 * The SDK types an MCP handler's second argument as `unknown`, so the id is
 * read defensively. Claude Code fills `_meta["claudecode/toolUseId"]` on
 * every `tools/call` it sends to an MCP server. The in-process server hands
 * the request's `_meta` through as `extra._meta`. That was measured
 * against the real bundled CLI (2.1.283, SDK 0.3.283), and
 * `tests/ask-tool-request-id.test.ts` re-measures it against whatever CLI
 * the lockfile installs. If a runtime ever stops sending it, the tool still
 * works. It falls back to a minted id: live delivery is unchanged, but
 * history can no longer correlate with it.
 */
export const TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

export function askRequestId(extra: unknown): string {
  const meta = extra && typeof extra === "object" ? (extra as { _meta?: unknown })._meta : undefined;
  const id =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>)[TOOL_USE_ID_META_KEY] : undefined;
  return typeof id === "string" && id.length > 0 ? id : crypto.randomUUID();
}
