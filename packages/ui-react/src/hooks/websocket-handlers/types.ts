import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
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
  requestBrowserLocation: (
    msg: Extract<ServerMessage, { type: "location_request" }>
  ) => void;
  resyncIfNeeded: (sessionId: string | null) => void;
  coldResumeIfNeeded: (sessionId: string | null, messageCount: number) => void;
  markHistoryReplaced: (key: ChatKey) => void;
}

export type ServerMessageHandlerMap<T extends ServerMessageType> = {
  [K in T]: (
    msg: Extract<ServerMessage, { type: K }>,
    context: DispatchContext
  ) => void;
};
