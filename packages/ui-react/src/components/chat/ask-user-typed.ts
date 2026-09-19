/**
 * The typed answer (D38 §1): a composer send while an `ask_user` question is
 * pending is the answer to that question, not a new message.
 *
 * The exchange is submitted through the same path the card's Submit uses —
 * the store records the answers and the socket carries `ask_user_response` —
 * with one difference: the exchange is marked `typed`, so the card quotes the
 * text it took instead of showing a chosen option. Dropping the card would
 * leave the transcript claiming the question was never answered; leaving it
 * pending would ask twice.
 */

import type { AskUserQuestion, ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AskUserExchange, ChatKey, ChatState } from "../../stores/chat-state.js";

/** A request the user has neither answered nor dismissed. */
export function isPendingExchange(
  exchange: AskUserExchange | null | undefined
): exchange is AskUserExchange {
  return !!exchange && !exchange.answers && !exchange.cancelled;
}

/**
 * The question the composer text answers. Answers are submitted for the whole
 * exchange at once, so this is the exchange's first question: a typed reply
 * to a multi-question prompt answers question one and leaves the rest blank.
 */
export function questionForTypedAnswer(exchange: AskUserExchange): AskUserQuestion | null {
  return exchange.questions[0] ?? null;
}

/**
 * Binds `text` to the buffer's pending question, if there is one. Returns
 * `true` when the text was consumed as an answer — the caller must then NOT
 * send it as a chat message — and `false` when nothing was pending.
 */
export function takeComposerTextAsAnswer(
  chat: Pick<ChatState, "submitAskUserAnswers"> & {
    buffers: ChatState["buffers"];
    draft: ChatState["draft"];
  },
  key: ChatKey,
  text: string,
  send: (message: ClientMessage) => void
): boolean {
  const buffer = key === null ? chat.draft : chat.buffers[key];
  const exchange = buffer?.askUser;
  if (!isPendingExchange(exchange)) return false;
  const question = questionForTypedAnswer(exchange);
  if (!question) return false;
  const answer = text.trim();
  if (!answer) return false;

  const answers = { [question.question]: answer };
  chat.submitAskUserAnswers(key, exchange.requestId, answers, undefined, true);
  send({ type: "ask_user_response", requestId: exchange.requestId, answers });
  return true;
}
