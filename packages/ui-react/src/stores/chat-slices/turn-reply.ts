import type { ChatMessage } from "../chat-state.js";

/**
 * The reply a turn's frame belongs to when no assistant message carries the
 * turn's id yet (#4565): the composer opens a reply before the host names
 * its turn, and a failure or stop with no deltas never stamps one.
 *
 * A reply still streaming that no other turn owns comes first, so a
 * follow-up queued below it does not move the frame past it. Otherwise it is
 * the last assistant message, but only if it answers the latest request: a
 * stop before that request's reply opened never claims an earlier answer.
 * -1 means no such reply; the caller opens one.
 */
export function unownedReplyIndex(msgs: readonly ChatMessage[], turnId: string | undefined,
  ownerOf: (message: ChatMessage) => string | undefined = (m) => m.turnId ?? m.streamTurnId): number {
  const unowned = (m: ChatMessage) => m.role === "assistant" && [undefined, turnId].includes(ownerOf(m));
  const streaming = msgs.findLastIndex((m) => unowned(m) && m.isStreaming);
  if (streaming !== -1) return streaming;
  const last = msgs.findLastIndex((m) => m.role === "assistant");
  return last !== -1 && last > msgs.findLastIndex((m) => m.role === "user") && unowned(msgs[last]!) ? last : -1;
}
