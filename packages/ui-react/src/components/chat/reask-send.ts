import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainStores } from "../../stores/create-stores.js";

/**
 * Send a dismissed question's answer again as an ordinary message (seventh
 * drop, ruling 7): the request was resolved server-side when the turn ended.
 * It takes the composer's path, minus attachments and provider (a resumed
 * session is pinned to its own), including its correlation: if the host
 * queues it behind a running turn, the host's report moves the message out of
 * the chat into the pending stack, and it comes back once, when its turn
 * starts (#1002). A refusal fails the reply opened for it, by the same id.
 */
export function sendReask(
  stores: Pick<BrainStores, "chat" | "connection">,
  sessionId: string | null,
  text: string,
  send: (msg: ClientMessage) => void | boolean,
): void {
  const chat = stores.chat.getState();
  const requestId = stores.connection.getState().chatRequestAck ? crypto.randomUUID() : undefined;
  chat.addUserMessage(sessionId, text, "typed", undefined, requestId ? { requestId } : undefined);
  if (!(sessionId === null ? chat.draft : chat.buffers[sessionId])?.isStreaming) {
    chat.startAssistantMessage(sessionId, undefined, requestId);
  }
  send({ type: "chat_message", text, sessionId: sessionId ?? undefined, source: "typed", ...(requestId ? { requestId } : {}) });
}
