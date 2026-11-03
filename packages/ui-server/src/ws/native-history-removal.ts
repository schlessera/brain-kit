/**
 * The native store's part of an explicit chat deletion (#3229): which
 * backends can remove native history at all, and how one retired chat's
 * removal is reported under its retirement. The endpoint, the other stores
 * and restart reconciliation coordinate these calls (#3230).
 * Policy: docs/decisions/chat-history-deletion.md.
 */
import type { AgentBackend, SessionHistoryRemovalOutcome } from "@schlessera/brain-ui-sdk/server";
import type { ChatRetirementStatus, RetireChatResult } from "./chat-lifecycle.js";
import type { SessionCatalog } from "./session-catalog.js";

/**
 * `RetireChatInput.removableBackends`: only a backend that both advertises
 * and implements removal. A chat on any other backend refuses as
 * `unsupported` before anything is retired.
 */
export function removableBackendIds(backends: Iterable<Pick<AgentBackend, "id" | "capabilities" | "removeSessionHistory">>): string[] {
  return [...backends].filter(backend => backend.capabilities.historyRemoval === true && typeof backend.removeSessionHistory === "function")
    .map(backend => backend.id);
}

/**
 * Ask the chat's backend to remove each retired native session under the
 * retirement's own operation, and record the native store's combined outcome.
 * Removal is confirmed only when the backend confirms every session; a
 * missing or unsupported backend, a rejection and an elapsed `signal` are not
 * completion. Repeating it under the same retirement is the retry.
 */
export async function removeRetiredNativeHistory(
  catalog: Pick<SessionCatalog, "recordChatCleanup">,
  backend: Pick<AgentBackend, "id" | "capabilities" | "removeSessionHistory"> | undefined,
  retirement: Extract<RetireChatResult, { status: "retired" }>,
  signal?: AbortSignal,
): Promise<ChatRetirementStatus | undefined> {
  // A provisional chat never had a native store selected.
  if (retirement.stores.native === undefined) return undefined;
  if (!catalog.recordChatCleanup) throw new Error("This catalog cannot record chat cleanup");
  const outcomes: SessionHistoryRemovalOutcome[] = [];
  const supported = backend && removableBackendIds([backend]).length === 1;
  for (const sessionId of retirement.identities.sessions) {
    if (!supported) { outcomes.push("partial"); continue; }
    try {
      outcomes.push((await backend!.removeSessionHistory!({ operationId: retirement.operationId, sessionId, ...(signal ? { signal } : {}) })).outcome);
    } catch { outcomes.push("unknown"); }
  }
  const outcome = outcomes.includes("unknown") ? "unknown" : outcomes.every(value => value === "removed") ? "removed" : "partial";
  return catalog.recordChatCleanup(retirement.lifecycleId, "native", outcome);
}
