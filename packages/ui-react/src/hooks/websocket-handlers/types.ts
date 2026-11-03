import type { InboxView, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { ChatKey, SessionChat } from "../../stores/chat-store.js";
import type { ChatState } from "../../stores/chat-state.js";
import type { BrainStores } from "../../stores/create-stores.js";

export type ServerMessageType = ServerMessage["type"];

export interface DispatchContext {
  state: ChatState;
  stores: BrainStores;
  frameSessionId: string | undefined;
  /** The host-minted turn the frame belongs to, when scoped (rev 2+). */
  frameTurnId: string | undefined;
  key: ChatKey;
  buffer: () => SessionChat | null | undefined;
  enqueueDelta: (key: ChatKey, kind: "text" | "thinking", text: string) => void;
  ensureActivitySubscription: (sessionId: string | null | undefined) => void;
  /** (Re-)subscribe one durable view; a repeat yields a fresh snapshot. */
  subscribeInbox: (view: InboxView) => void;
  requestBrowserLocation: (
    msg: Extract<ServerMessage, { type: "location_request" }>
  ) => void;
  resyncIfNeeded: (sessionId: string | null) => void;
  /**
   * An idle status for the selected session (or the host's unscoped
   * greeting): its history, if still unconfirmed, is asked for again (#1328).
   */
  restoreIfNeeded: (frameSessionId: string | null) => void;
  markHistoryReplaced: (key: ChatKey) => void;
  /** A failed turn's retry was received, refused or is unknown. */
  retryReceipt: (msg: Extract<ServerMessage, { type: "retry_receipt" }>) => void;
  /** The host's receipt for a queued answer (D52 §2). */
  answerReceipt: (msg: Extract<ServerMessage, { type: "ask_answer_receipt" }>) => void;
  /** A session's pending follow-ups, as the host holds them (#1002). */
  queueReport: (msg: Extract<ServerMessage, { type: "session_queue" }>) => void;
}

export type ServerMessageHandlerMap<T extends ServerMessageType> = {
  [K in T]: (
    msg: Extract<ServerMessage, { type: K }>,
    context: DispatchContext
  ) => void;
};
