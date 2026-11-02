import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { localExchangesForDraft, restorationOf } from "../stores/chat-state.js";
import type { BrainUiServices } from "../root.js";
import type { RestorationDriver } from "./restoration.js";

export interface OutboundSocket {
  send(message: ClientMessage): boolean;
}

export interface OutboundDeps {
  /** The current socket, or null while none is leased. */
  socket: () => OutboundSocket | null;
  /** The voice conversation that owns a session's history, if any. */
  historyOwnerFor: (sessionId: string) => string | undefined;
  /** Read a voice-owned session's dialogue instead of its transcript. */
  loadDialogue: (sessionId: string) => void;
  restoration: Pick<RestorationDriver, "resume">;
}

/**
 * Every client frame leaves through here, in a fixed order of refusals and
 * rewrites: a locked account, no socket, a socket not connected, then a
 * selected session still restoring. Only then is a frame rerouted (voice
 * history owners), deduplicated (one restore request per socket) or extended
 * (a new conversation's local exchanges). Returns whether the frame left.
 */
export function createOutbound(root: Pick<BrainUiServices, "stores" | "authLock">, deps: OutboundDeps) {
  return function send(msg: ClientMessage): boolean {
    if (root.authLock.state.getState().phase !== "active") return false;
    const socket = deps.socket();
    if (!socket) return false;
    if (root.stores.connection.getState().wsStatus !== "connected") return false;
    // Nothing goes into a selected session whose history the reader has not
    // seen (#1328), whichever surface sends it.
    const into = msg.type === "chat_message" || msg.type === "local_exchange" || msg.type === "retry_turn" ? msg.sessionId : undefined;
    if (into && restorationOf(root.stores.chat.getState())?.sessionId === into) return false;
    if (msg.type === "chat_message" && msg.sessionId && deps.historyOwnerFor(msg.sessionId)) msg = { ...msg, historyOwnerId: deps.historyOwnerFor(msg.sessionId), sessionId: undefined };
    if (msg.type === "session_resume" && deps.historyOwnerFor(msg.sessionId)) {
      deps.loadDialogue(msg.sessionId);
      return true;
    }
    if (msg.type === "session_resume") return deps.restoration.resume(msg, (message) => socket.send(message));
    // A message that starts a conversation takes the draft's local exchanges
    // with it (#582), whichever surface sent it, so /stats run before the
    // first message becomes part of the session that message creates.
    if (msg.type === "chat_message" && !msg.sessionId && !msg.historyOwnerId) {
      const chat = root.stores.chat.getState();
      const exchanges = localExchangesForDraft(chat);
      if (exchanges.length > 0) {
        const sent = socket.send({ ...msg, localExchanges: exchanges });
        if (sent) for (const exchange of exchanges) chat.markLocalExchange(exchange.id, "pending");
        return sent;
      }
    }
    return socket.send(msg);
  };
}
