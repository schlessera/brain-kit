import { approvalRequestFrame, withTurnScope } from "./frames.js";
import type { WSContext } from "./clients.js";
import type { WsHost } from "./host.js";

/**
 * Re-send every pending approval and ask-user card to a client that just
 * connected. These survive disconnects (see drainClientBoundForTurn) precisely
 * so this re-delivery can happen: a phone that dropped its socket at screen
 * lock reconnects and finds the card waiting instead of a dead turn. The
 * frames carry their original turn scope, so answering them resolves the
 * correct turn's promise through the normal dispatch path.
 */
export function resendPendingInteractive(host: WsHost, ws: WSContext): void {
  resendPendingApprovals(host, ws);
  resendPendingAsks(host, ws);
}

/**
 * Re-send pending approval cards, optionally only those of one session.
 * `session_resume` uses the filtered form after its history replaced the
 * client's transcript (#964): a replay that ends on the user's message has
 * no answer to carry the card, so without this a reload lost it. Only what
 * is still pending goes out, under its original turn, so a settled approval
 * is never revived and a repeated resume re-sends the same card, not a new one.
 */
export function resendPendingApprovals(host: WsHost, ws: WSContext, sessionId?: string): void {
  for (const p of host.coordinator.pendingApprovals.values()) {
    if (sessionId !== undefined && p.turn.sessionId !== sessionId) continue;
    host.sendMessage(
      ws,
      withTurnScope(
        approvalRequestFrame(p.request, host.toolPermissions !== null),
        p.turn,
        p.turnId
      )
    );
  }
}

/**
 * Re-send the pending questions of all four ask kinds, optionally only those
 * of one session. `session_resume` uses the filtered form after its history
 * replaced the client's transcript (#910).
 */
export function resendPendingAsks(host: WsHost, ws: WSContext, sessionId?: string): void {
  const { coordinator } = host;
  const wanted = (p: { turn: { sessionId: string | null } }) =>
    sessionId === undefined || p.turn.sessionId === sessionId;
  for (const p of coordinator.pendingAskUser.values()) {
    if (!wanted(p)) continue;
    host.sendMessage(
      ws,
      withTurnScope({ type: "ask_user_request", requestId: p.requestId, questions: p.questions }, p.turn, p.turnId)
    );
  }
  for (const p of coordinator.pendingAskUserList.values()) {
    if (!wanted(p)) continue;
    host.sendMessage(ws, withTurnScope({ type: "ask_user_list_request", requestId: p.requestId, ...p.request }, p.turn, p.turnId));
  }
  for (const p of coordinator.pendingAskUserRank.values()) {
    if (!wanted(p)) continue;
    host.sendMessage(ws, withTurnScope({ type: "ask_user_rank_request", requestId: p.requestId, ...p.request }, p.turn, p.turnId));
  }
  for (const p of coordinator.pendingAskUserForm.values()) {
    if (!wanted(p)) continue;
    host.sendMessage(ws, withTurnScope({ type: "ask_user_form_request", requestId: p.requestId, ...p.request }, p.turn, p.turnId));
  }
}
