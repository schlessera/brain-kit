/**
 * Ask answers with delivery receipts (rev 5, #910).
 *
 * Before this, an answer the host could not match was dropped without a frame
 * or a log line, and a client marked its card answered the moment it called
 * `send()`. Now every answer names one submitted answer (`submissionId`), and
 * the host tells the sender what became of it: settled by it, or closed and
 * why. The same submission repeated after a lost receipt gets the same
 * receipt and settles nothing a second time.
 *
 * An answer without a `submissionId` comes from a client that cannot read a
 * receipt. Settling it would show that client an acceptance it never
 * confirmed, and leave a lost answer looking delivered, so it is refused with
 * an update-required error and the question stays waiting (Compatibility B).
 */
import {
  ASK_ANSWER_UPDATE_REQUIRED,
  type ClientAskAnswerStatus,
  type ClientAskUserFormResponse,
  type ClientAskUserListResponse,
  type ClientAskUserRankResponse,
  type ClientAskUserResponse,
  type ServerAskAnswerReceipt,
} from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import type { WsHost } from "./host.js";
import type {
  AskKind,
  PendingAskUser,
  PendingAskUserForm,
  PendingAskUserList,
  PendingAskUserRank,
  TurnCoordinator,
} from "./turns.js";

type AskAnswer =
  | ClientAskUserResponse
  | ClientAskUserListResponse
  | ClientAskUserRankResponse
  | ClientAskUserFormResponse;

type PendingAsk =
  | { kind: "ask_user"; entry: PendingAskUser }
  | { kind: "ask_user_list"; entry: PendingAskUserList }
  | { kind: "ask_user_rank"; entry: PendingAskUserRank }
  | { kind: "ask_user_form"; entry: PendingAskUserForm };

const ANSWER_KIND: Record<AskAnswer["type"], AskKind> = {
  ask_user_response: "ask_user",
  ask_user_list_response: "ask_user_list",
  ask_user_rank_response: "ask_user_rank",
  ask_user_form_response: "ask_user_form",
};

/** The pending ask with this id, of whichever kind. The kinds share one id space. */
export function findPendingAsk(coordinator: TurnCoordinator, requestId: string): PendingAsk | undefined {
  const ask = coordinator.pendingAskUser.get(requestId);
  if (ask) return { kind: "ask_user", entry: ask };
  const list = coordinator.pendingAskUserList.get(requestId);
  if (list) return { kind: "ask_user_list", entry: list };
  const rank = coordinator.pendingAskUserRank.get(requestId);
  if (rank) return { kind: "ask_user_rank", entry: rank };
  const form = coordinator.pendingAskUserForm.get(requestId);
  if (form) return { kind: "ask_user_form", entry: form };
  return undefined;
}

/** The receipt for a request that is no longer pending, from its recorded outcome. */
function settledReceipt(
  coordinator: TurnCoordinator,
  requestId: string,
  submissionId: string,
  principalId: string
): Pick<ServerAskAnswerReceipt, "state" | "reason" | "sessionId" | "turnId"> {
  const outcome = coordinator.askOutcome(requestId);
  if (!outcome) return { state: "closed", reason: "not_recognized" };
  const scope = {
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    turnId: outcome.turnId,
  };
  if (outcome.state === "closed") return { state: "closed", reason: outcome.reason ?? "ended", ...scope };
  // Accepted: by THIS submission from this principal, or by something else.
  // A receipt is bound to its caller, like a retry receipt: another principal
  // learns nothing about whose answer settled it.
  if (outcome.principalId !== principalId) return { state: "closed", reason: "not_recognized" };
  if (outcome.submissionId === submissionId) return { state: "accepted", ...scope };
  return { state: "closed", reason: "answered_elsewhere", ...scope };
}

function sendReceipt(
  host: WsHost,
  ws: WSContext,
  requestId: string,
  submissionId: string,
  receipt: Pick<ServerAskAnswerReceipt, "state" | "reason" | "sessionId" | "turnId">
): void {
  host.sendMessage(ws, { type: "ask_answer_receipt", requestId, submissionId, ...receipt });
}

/**
 * Settle a pending ask from one answer frame, at most once, and tell the
 * sender. `principalId` is the connection's; `requireEcho` is ignored for a
 * receipt-carrying answer, which must always name its turn.
 */
export function handleAskAnswer(
  host: WsHost,
  ws: WSContext,
  msg: AskAnswer,
  principalId: string
): void {
  const { coordinator } = host;
  if (!msg.submissionId) {
    host.reportDroppedFrame("ask_answer_without_receipt", msg.type);
    host.sendMessage(ws, {
      type: "error",
      code: ASK_ANSWER_UPDATE_REQUIRED,
      message:
        "This app is too old to answer questions on this server. Reload or update it; the question is still waiting.",
      requestId: msg.requestId,
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    });
    return;
  }
  const submissionId = msg.submissionId;
  const pending = findPendingAsk(coordinator, msg.requestId);
  if (!pending) {
    sendReceipt(host, ws, msg.requestId, submissionId, settledReceipt(coordinator, msg.requestId, submissionId, principalId));
    return;
  }
  const { entry } = pending;
  const scope = {
    ...(entry.turn.sessionId ? { sessionId: entry.turn.sessionId } : {}),
    turnId: entry.turnId,
  };
  // The binding is checked, not trusted: a stale turn, another session, or an
  // answer shaped for another kind must not settle this request. The request
  // stays pending for an answer that does match.
  if (
    pending.kind !== ANSWER_KIND[msg.type] ||
    msg.turnId !== entry.turnId ||
    (msg.sessionId !== undefined && entry.turn.sessionId !== null && msg.sessionId !== entry.turn.sessionId)
  ) {
    sendReceipt(host, ws, msg.requestId, submissionId, { state: "closed", reason: "refused", ...scope });
    return;
  }

  switch (pending.kind) {
    case "ask_user":
      coordinator.pendingAskUser.delete(msg.requestId);
      break;
    case "ask_user_list":
      coordinator.pendingAskUserList.delete(msg.requestId);
      break;
    case "ask_user_rank":
      coordinator.pendingAskUserRank.delete(msg.requestId);
      break;
    case "ask_user_form":
      coordinator.pendingAskUserForm.delete(msg.requestId);
      break;
  }
  coordinator.recordAskOutcome({
    requestId: msg.requestId,
    sessionId: entry.turn.sessionId,
    turnId: entry.turnId,
    state: "accepted",
    submissionId,
    principalId,
    at: Date.now(),
  });
  entry.turn.recorder?.recordAskUserResponse(principalId);
  if (pending.kind === "ask_user" && msg.type === "ask_user_response") {
    pending.entry.resolve({ answers: msg.answers, annotations: msg.annotations });
  } else if (pending.kind === "ask_user_list" && msg.type === "ask_user_list_response") {
    pending.entry.resolve({ answers: msg.answers, ...(msg.notes ? { notes: msg.notes } : {}) });
  } else if (pending.kind === "ask_user_rank" && msg.type === "ask_user_rank_response") {
    pending.entry.resolve({ order: msg.order, unchanged: msg.unchanged });
  } else if (pending.kind === "ask_user_form" && msg.type === "ask_user_form_response") {
    pending.entry.resolve({ answers: msg.answers });
  }
  sendReceipt(host, ws, msg.requestId, submissionId, { state: "accepted", ...scope });
}

/** Answer `ask_answer_status` without settling anything. */
export function handleAskAnswerStatus(
  host: WsHost,
  ws: WSContext,
  msg: ClientAskAnswerStatus,
  principalId: string
): void {
  const pending = findPendingAsk(host.coordinator, msg.requestId);
  if (!pending) {
    sendReceipt(host, ws, msg.requestId, msg.submissionId, settledReceipt(host.coordinator, msg.requestId, msg.submissionId, principalId));
    return;
  }
  const { entry } = pending;
  const scope = {
    ...(entry.turn.sessionId ? { sessionId: entry.turn.sessionId } : {}),
    turnId: entry.turnId,
  };
  if (msg.sessionId !== undefined && entry.turn.sessionId !== null && msg.sessionId !== entry.turn.sessionId) {
    sendReceipt(host, ws, msg.requestId, msg.submissionId, { state: "closed", reason: "refused", ...scope });
    return;
  }
  sendReceipt(host, ws, msg.requestId, msg.submissionId, { state: "pending", ...scope });
}
