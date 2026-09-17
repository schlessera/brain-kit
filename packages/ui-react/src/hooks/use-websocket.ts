import { useEffect, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { defaultRoot } from "../default-root.js";
import { useBrainUiRoot } from "../root-context.js";
export { runStateForFrame } from "./websocket-handlers/chat.js";

/** Default-app entry points for callers outside React. */
export function handleServerMessage(message: ServerMessage) { defaultRoot.connection.handleServerMessage(message); }
export function flushChatDeltas() { defaultRoot.connection.flushChatDeltas(); }
export function sendClientMessage(message: ClientMessage) { return defaultRoot.connection.send(message); }
export function reconnectWebSocketNow() { defaultRoot.connection.reconnectNow(); }

export function useWebSocket() {
  const root = useBrainUiRoot();
  useEffect(() => root.connection.connect(), [root]);
  const send = useCallback((message: ClientMessage) => root.connection.send(message), [root]);
  return { send };
}
