import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";

/** How long a sent retry waits for its receipt before it reads as unknown. */
export const RETRY_RECEIPT_WAIT_MS = 5000;

/**
 * Retrying a failed turn: the request, its receipt and the socket's part in
 * both. A retry is sent once; a lost acknowledgement is asked about again
 * (`retry_status`), never sent a second time.
 */
export function createTurnRetries(
  chatStore: BrainUiServices["stores"]["chat"],
  send: (message: ClientMessage) => boolean,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function retryTurn(failedTurnId: string): "sent" | "pending" | "refused" {
    const chat = chatStore.getState();
    const sessionId = chat.activeSessionId;
    if (!sessionId) return "refused";
    const pending = chat.turnRetries[sessionId];
    if (pending?.failedTurnId === failedTurnId && pending.state !== "refused") return "pending";
    const buffer = chat.buffers[sessionId];
    const last = buffer?.messages.at(-1);
    if (last?.failure?.resetsAt !== undefined && last.failure.resetsAt > Date.now()) return "refused";
    if (buffer?.isStreaming || chat.runStates[sessionId] === "streaming" || last?.retryOfTurnId !== failedTurnId || !last.failure) return "refused";
    const retry = { requestId: crypto.randomUUID(), failedTurnId, state: "waiting" as const };
    chat.setTurnRetry(sessionId, retry);
    if (!send({ type: "retry_turn", sessionId, failedTurnId, requestId: retry.requestId })) {
      chat.setTurnRetry(sessionId, { ...retry, state: "refused", message: "Couldn't send. Check the connection and try again." });
      return "refused";
    }
    timers.set(sessionId, setTimeout(() => {
      const state = chatStore.getState();
      const current = state.turnRetries[sessionId];
      if (current?.requestId === retry.requestId && current.state === "waiting") state.setTurnRetry(sessionId, { ...current, state: "unknown" });
      timers.delete(sessionId);
    }, RETRY_RECEIPT_WAIT_MS));
    return "sent";
  }

  function checkDelivery(sessionId: string): boolean {
    const pending = chatStore.getState().turnRetries[sessionId];
    return Boolean(pending && send({ type: "retry_status", sessionId, requestId: pending.requestId }));
  }

  function receipt(msg: Extract<ServerMessage, { type: "retry_receipt" }>): void {
    const sessionId = msg.sessionId;
    if (!sessionId) return;
    const chat = chatStore.getState();
    const pending = chat.turnRetries[sessionId];
    if (!pending || pending.requestId !== msg.requestId) return;
    clearTimeout(timers.get(sessionId)); timers.delete(sessionId);
    if (msg.state === "unknown") { chat.setTurnRetry(sessionId, { ...pending, state: "unknown" }); return; }
    if (msg.state === "refused") { chat.setTurnRetry(sessionId, { ...pending, state: "refused", message: msg.message ?? "The server refused this retry." }); return; }
    chat.setTurnRetry(sessionId, null);
    const buffer = chat.buffers[sessionId];
    if (msg.text !== undefined && pending.state === "waiting" && buffer?.messages.at(-1)?.retryOfTurnId === pending.failedTurnId) {
      chat.addUserMessage(sessionId, msg.text, msg.source, undefined, { requestId: msg.requestId, thinkingLevel: msg.thinkingLevel }, msg.files);
      if (msg.attachmentCount) {
        const current = chatStore.getState().buffers[sessionId];
        const messages = [...current.messages];
        messages[messages.length - 1] = { ...messages.at(-1)!, attachmentCount: msg.attachmentCount };
        chatStore.setState({ buffers: { ...chatStore.getState().buffers, [sessionId]: { ...current, messages } } });
      }
      chat.startAssistantMessage(sessionId, undefined, msg.requestId);
    } else {
      // A receipt recovered after a lost acknowledgement heals from history;
      // it never sends the original request a second time.
      send({ type: "session_resume", sessionId });
    }
  }

  /** A new socket asks after every retry still waiting for its receipt. */
  function connected(): void {
    for (const sessionId of Object.keys(chatStore.getState().turnRetries)) checkDelivery(sessionId);
  }

  /** Nothing sent can be confirmed across a dropped socket. */
  function disconnected(): void {
    const chat = chatStore.getState();
    for (const [sessionId, pending] of Object.entries(chat.turnRetries)) {
      if (pending.state === "waiting") chat.setTurnRetry(sessionId, { ...pending, state: "unknown" });
    }
  }

  function clearTimers(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { retryTurn, checkDelivery, receipt, connected, disconnected, clearTimers };
}

export type TurnRetries = ReturnType<typeof createTurnRetries>;
