/**
 * The typed answer (D38 §1): a composer send while an `ask_user` question is
 * pending is the answer to that question, not a new message.
 *
 * The exchange is submitted through the same path the card's Submit uses —
 * the answer queue (#910), which records the answer and carries it to the
 * host — with one difference: the answer is marked `typed`, so the card
 * quotes the text it took instead of showing a chosen option. Dropping the card would
 * leave the transcript claiming the question was never answered; leaving it
 * pending would ask twice.
 */

import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import type { AskUserExchange, ChatKey, ChatState } from "../../stores/chat-state.js";
import type { SubmitAnswer } from "../../lib/answer-delivery/manager.js";
import { isRefusedAdmission } from "../../lib/answer-delivery/types.js";

/** A request the user has neither answered nor dismissed. */
export function isPendingExchange(
  exchange: AskUserExchange | null | undefined
): exchange is AskUserExchange {
  return !!exchange && !exchange.answers && !exchange.order && !exchange.formAnswers && !exchange.cancelled;
}

/**
 * The question the composer text answers — only when the exchange has exactly
 * one. Answers are submitted for the whole exchange at once and the server
 * resolves the request on the first response, so binding a typed reply to
 * question one of several would leave the others blank and unanswerable. A
 * multi-question prompt keeps the cards' own Submit; the composer text is an
 * ordinary message.
 */
export function questionForTypedAnswer(exchange: AskUserExchange): AskUserQuestion | null {
  return exchange.questions.length === 1 ? exchange.questions[0]! : null;
}

/**
 * Binds `text` to the buffer's pending question, if there is one. Returns
 * `true` when the text was consumed as an answer — the caller must then NOT
 * send it as a chat message — and `false` when nothing was pending.
 */
export function takeComposerTextAsAnswer(
  chat: Pick<ChatState, "buffers" | "draft" | "deliveries">,
  key: ChatKey,
  text: string,
  submit: (answer: SubmitAnswer) => void
): boolean {
  const buffer = key === null ? chat.draft : chat.buffers[key];
  const exchange = buffer?.askUser;
  if (!isPendingExchange(exchange)) return false;
  // Already submitted and on its way (still being saved, say): this text is
  // not a second answer to it.
  const delivery = chat.deliveries[exchange.requestId];
  if (delivery && !isRefusedAdmission(delivery.state)) return false;
  const question = questionForTypedAnswer(exchange);
  if (!question) return false;
  const answer = text.trim();
  if (!answer) return false;

  submit({
    requestId: exchange.requestId,
    sessionId: key,
    ...(exchange.turnId ? { turnId: exchange.turnId } : {}),
    payload: { kind: "ask_user", answers: { [question.question]: answer }, typed: true },
    // The writer is in the composer and stays there.
    focus: false,
  });
  return true;
}

/**
 * The composer message a reopened (dismissed, then "Ask again") card sends
 * in place of an `ask_user_response`: the server resolved the request when
 * the turn ended, so the answer has to travel as a normal message that
 * quotes the question it answers. One block per question, the picks as
 * they were recorded.
 */
export function reaskMessage(
  questions: readonly Pick<AskUserQuestion, "question">[],
  answers: Record<string, string>
): string {
  return questions
    .map((q) => `Answering \u201C${q.question}\u201D: ${answers[q.question] ?? ""}`)
    .join("\n\n");
}
