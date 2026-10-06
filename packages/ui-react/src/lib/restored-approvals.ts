import type { SessionRecovery } from "@schlessera/brain-ui-sdk/protocol";
import type { SessionChat, ToolCall } from "../stores/chat-state.js";

/**
 * Restored approval cards (#1072, D52 §4 R3): the pure part. A restored
 * card's controls stay live only while the host lists its request as
 * pending. Otherwise it is read-only, with the host fact that closed it:
 *
 * - `answered`: a `tool_result` for it arrived while it was waiting here, or
 *   the envelope no longer lists it while the turn that raised it is still
 *   the session's running turn. The host drops a pending approval during
 *   its turn only on a decision; the turn's end drains the rest.
 * - `ended`: the turn that raised it is terminal or gone (a terminal frame
 *   for that turn, an envelope whose latest turn is that one ended or lost,
 *   or a newer one, or a session the host no longer knows).
 * - `revoked`: the read was unauthorized, or a revocation closed the socket.
 * - `unlisted`: the envelope does not list it, and nothing yet says why (a
 *   newer request is queued, or the latest request's fate is unknown). The
 *   controls are gone and no word is printed: the next terminal frame,
 *   result or read says which.
 *
 * Nothing here sends a frame. Rehydration never replies.
 */
export type RestoredApprovalClosure = "answered" | "ended" | "revoked" | "unlisted";

/** D52 §4 R3's words, verbatim. `unlisted` has none. */
export const RESTORED_APPROVAL_WORDS: Record<Exclude<RestoredApprovalClosure, "unlisted">, string> = {
  answered: "answered on another device",
  ended: "ended with the turn",
  revoked: "no longer yours to answer",
};

export function restoredApprovalWord(closure: RestoredApprovalClosure | undefined): string | null {
  return closure && closure !== "unlisted" ? RESTORED_APPROVAL_WORDS[closure] : null;
}

/** A restored card that still takes a decision, with the turn that raised it. */
export interface AwaitingRestoredCard {
  toolUseId: string;
  turnId: string | null;
}

/** A restored card is open: pending here, and not closed, or closed only as `unlisted`. */
export function isOpenRestored(tool: ToolCall): boolean {
  return !!tool.restored && tool.status === "pending_approval" && (!tool.readOnly || tool.readOnly === "unlisted");
}

/** The open restored cards in one buffer. */
export function openRestoredCards(chat: SessionChat | null | undefined): AwaitingRestoredCard[] {
  if (!chat) return [];
  const out: AwaitingRestoredCard[] = [];
  for (const message of chat.messages) {
    for (const tool of message.toolCalls) {
      if (isOpenRestored(tool)) out.push({ toolUseId: tool.id, turnId: tool.approvalTurnId ?? null });
    }
  }
  return out;
}

/**
 * Restored cards that a `tool_result` answered while they waited here: open
 * in `before`, complete in `after`, still marked restored. A decision on
 * this page moves a card to approved or denied first, and a replay rebuilds
 * a call without the restored mark, so neither reads as answered.
 */
export function answeredByResult(before: SessionChat | null | undefined, after: SessionChat | null | undefined): string[] {
  if (!before || !after || before === after) return [];
  const open = new Set(openRestoredCards(before).map((c) => c.toolUseId));
  if (open.size === 0) return [];
  const out: string[] = [];
  for (const message of after.messages) {
    for (const tool of message.toolCalls) {
      if (open.has(tool.id) && tool.restored && tool.status === "complete") out.push(tool.id);
    }
  }
  return out;
}

/**
 * Why an envelope read that began after `card` was restored no longer lists
 * it, or null while it does. Host facts only: a request the envelope does
 * not list, with no fact that says why, is `unlisted`.
 */
export function closureFromEnvelope(card: AwaitingRestoredCard, recovery: SessionRecovery): RestoredApprovalClosure | null {
  if (recovery.pending.some((p) => p.kind === "approval" && p.requestId === card.toolUseId)) return null;
  const latest = recovery.latest;
  if (card.turnId === null) return "unlisted";
  if (latest.turnId === card.turnId) {
    if (latest.state === "running") return "answered";
    if (latest.state === "terminal" || latest.state === "unknown") return "ended";
    return "unlisted";
  }
  // One session runs one turn at a time: a newer turn started or ended
  // after the card's own turn ended.
  if (latest.turnId !== null) return "ended";
  return "unlisted";
}
