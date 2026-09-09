import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { ChatKey, SessionChat } from "../../stores/chat-store.js";
import { useChatStore } from "../../stores/chat-store.js";

export type ServerMessageType = ServerMessage["type"];

export interface DispatchContext {
  state: ReturnType<typeof useChatStore.getState>;
  frameSessionId: string | undefined;
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
