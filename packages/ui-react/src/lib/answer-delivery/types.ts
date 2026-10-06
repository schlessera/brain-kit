/**
 * Answer delivery for the four ask tools (#910): the shapes shared by the
 * queue, its storage, the tab coordination and the cards.
 *
 * The policy these encode was ruled on the issue and is not this code's to
 * change: Recovery B (automatic retry of explicitly submitted answers only),
 * Compatibility B (receipt-capable peers required), Lifetime B (persisted on
 * this device through reload), Liveness B (15/5 s) and Queue A (16 answers,
 * 16 MiB, 24 hours). See docs/decisions/answer-delivery.md.
 */
import type {
  AskUserAnnotation,
  AskUserFormAnswers,
  ClientMessage,
  ServerAskAnswerReceipt,
} from "@schlessera/brain-ui-sdk/protocol";

export type AskKind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";

/** What the user submitted, in the shape of its kind. Immutable once queued. */
export type AnswerPayload =
  | {
      kind: "ask_user";
      answers: Record<string, string>;
      annotations?: Record<string, AskUserAnnotation>;
      /** Taken from the composer (D38 §1), not chosen on the card. */
      typed?: boolean;
    }
  | { kind: "ask_user_list"; answers: Record<string, string>; notes?: Record<string, string> }
  | { kind: "ask_user_rank"; order: string[]; unchanged: boolean }
  | { kind: "ask_user_form"; answers: AskUserFormAnswers; visibleNodes: string[] };

/** Queue A: at most this many submitted answers wait per device and principal. */
export const MAX_QUEUED_ANSWERS = 16;
/** Queue A: at most this many UTF-8 bytes of serialized queued answers. */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
/** Queue A: automatic replay stops this long after the original Submit. */
export const MAX_REPLAY_AGE_MS = 24 * 60 * 60 * 1000;
/** Queue A: how long to wait for a receipt before checking again. */
export const RECEIPT_WATCHDOG_MS = 5_000;

/**
 * One submitted answer as it is persisted. `submissionId` is minted once, at
 * Submit, and every retry reuses it; `submittedAt` never moves, so neither a
 * reload nor a retry resets the 24-hour bound.
 */
export interface QueuedAnswer {
  v: 1;
  submissionId: string;
  /** The principal it was submitted as (`server_hello.principalKey`). */
  principalKey: string;
  requestId: string;
  sessionId: string | null;
  /** The request's turn, when known; learned from the host otherwise. */
  turnId: string | null;
  payload: AnswerPayload;
  submittedAt: number;
  /**
   * It has been handed to an open socket at least once, so the host may have
   * it. From then on it can only be resolved by a receipt, never edited.
   */
  sent: boolean;
}

export type ClosedReason = NonNullable<ServerAskAnswerReceipt["reason"]>;

/**
 * Where one submitted answer stands, as the card shows it. The tags and the
 * transitions between them are the approved design's §2–§3:
 *
 * - `saving` — being written to this device before anything else happens.
 * - `queued` — saved, never sent; it sends itself once the host is back.
 * - `awaiting` — sent (possibly more than once); no receipt yet.
 * - `answered` — the host's receipt says it took this answer.
 * - `closed` — the host says the question will not take it.
 * - `expired` — 24 hours passed without a receipt; replay stopped.
 * - `cancelled` — the user stopped it before it was ever sent.
 * - `update` — this app or the host cannot do receipts.
 * - `full` — 16 answers or 16 MiB are already waiting; this one was not admitted.
 * - `notSaved` — this device could not store it, so it was not sent either.
 * - `signedOut` — the principal changed or signed out before it was confirmed.
 */
export type DeliveryState =
  | "saving"
  | "queued"
  | "awaiting"
  | "answered"
  | "closed"
  | "expired"
  | "cancelled"
  | "update"
  | "full"
  | "notSaved"
  | "signedOut";

export interface AnswerDelivery {
  requestId: string;
  submissionId: string;
  sessionId: string | null;
  state: DeliveryState;
  payload: AnswerPayload;
  submittedAt: number;
  /** When the host (or the local bound) settled it. */
  settledAt?: number;
  reason?: ClosedReason;
  /** On `full`: which budget refused it. */
  full?: "count" | "bytes";
  /** On `cancelled`: the host confirmed the question is still waiting. */
  editable?: boolean;
  /** Another tab owns this submission; this one only shows it. */
  mirror?: boolean;
  /** This tab just submitted it: the card moves focus to its status. */
  focus?: boolean;
}

/** States in which the answer may still reach the host. */
export function isUnconfirmed(state: DeliveryState): boolean {
  return state === "saving" || state === "queued" || state === "awaiting";
}

/** States in which the card keeps its editable form, because nothing was admitted. */
export function isRefusedAdmission(state: DeliveryState): boolean {
  return state === "full" || state === "notSaved";
}

/** UTF-8 bytes of the serialized record: what Queue A's byte budget counts. */
export function queuedBytes(item: QueuedAnswer): number {
  return new TextEncoder().encode(JSON.stringify(item)).length;
}

/** The answer frame for one queued item, with its full binding. */
export function answerFrame(item: QueuedAnswer & { turnId: string }): ClientMessage {
  const binding = {
    requestId: item.requestId,
    submissionId: item.submissionId,
    turnId: item.turnId,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
  };
  const p = item.payload;
  switch (p.kind) {
    case "ask_user":
      return { type: "ask_user_response", ...binding, answers: p.answers, ...(p.annotations ? { annotations: p.annotations } : {}) };
    case "ask_user_list":
      return { type: "ask_user_list_response", ...binding, answers: p.answers, ...(p.notes ? { notes: p.notes } : {}) };
    case "ask_user_rank":
      return { type: "ask_user_rank_response", ...binding, order: p.order, unchanged: p.unchanged };
    case "ask_user_form":
      return { type: "ask_user_form_response", ...binding, answers: p.answers };
  }
}
