/**
 * A submitted answer as the card shows it, and as text (#910).
 *
 * `withSubmittedAnswer` lays the queued payload over the exchange the
 * transcript holds, so a card the history rebuilt after a reload shows what
 * the user submitted rather than an empty question. `answerAsMessage` is the
 * same answer as an ordinary chat message, for `Copy answer` and the
 * explicit `Send as message` on a closed or expired card: the same words a
 * reopened card's reask uses, so the agent reads both the same way.
 */
import { askUserFormPayload } from "@schlessera/brain-ui-sdk/internal/client";
import type { IconName } from "@schlessera/brain-ui-kit";
import type { AskUserExchange } from "../../stores/chat-state.js";
import { isSettledExchange } from "../../stores/chat-state.js";
import type { AnswerDelivery, AnswerPayload } from "../../lib/answer-delivery/types.js";
import { reaskMessage } from "./ask-user-typed.js";
import { listReaskMessage } from "./ask-user-list-card.js";
import { formReaskMessage, rankReaskMessage } from "./reask-text.js";

/**
 * The head a card's record carries while its answer is not confirmed: the
 * answer is shown, and the footer below says where it stands (#910).
 */
export interface RecordHead {
  head: string;
  icon: IconName;
}
export const UNCONFIRMED_RECORD: RecordHead = { head: "Your answer", icon: "send" };

export function withSubmittedAnswer(exchange: AskUserExchange, delivery: AnswerDelivery): AskUserExchange {
  // Once the host confirmed it, the transcript's own record is that answer.
  // Before then, and when another answer closed the question, the card shows
  // what THIS user submitted: the footer says it is kept, and Copy copies it.
  if (delivery.state === "answered" && isSettledExchange(exchange) && !exchange.cancelled) return exchange;
  const p = delivery.payload;
  const base = { ...exchange, cancelled: undefined };
  switch (p.kind) {
    case "ask_user":
      return { ...base, answers: p.answers, annotations: p.annotations, ...(p.typed ? { typed: true } : {}) };
    case "ask_user_list":
      return { ...base, answers: p.answers, ...(p.notes ? { notes: p.notes } : {}) };
    case "ask_user_rank":
      return { ...base, order: p.order, unchanged: p.unchanged };
    case "ask_user_form":
      return { ...base, formAnswers: p.answers, visibleNodes: p.visibleNodes };
  }
}

export function answerAsMessage(exchange: AskUserExchange, payload: AnswerPayload): string {
  switch (payload.kind) {
    case "ask_user":
      return reaskMessage(exchange.questions, payload.answers);
    case "ask_user_list":
      return exchange.list ? listReaskMessage(exchange.list, payload.answers, payload.notes) : JSON.stringify(payload.answers);
    case "ask_user_rank":
      return exchange.rank ? rankReaskMessage(exchange.rank, payload.order) : payload.order.join(", ");
    case "ask_user_form": {
      if (!exchange.form) return JSON.stringify(payload.answers);
      let result: unknown = { answers: payload.answers, visibleNodes: payload.visibleNodes };
      try {
        result = askUserFormPayload(exchange.form, { answers: payload.answers });
      } catch {
        // Show what was submitted even when it no longer validates.
      }
      return formReaskMessage(exchange.form, result);
    }
  }
}
