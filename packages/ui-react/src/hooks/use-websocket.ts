import { useEffect, useCallback } from "react";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../root-context.js";
export { runStateForFrame } from "./websocket-handlers/chat.js";

export function useWebSocket() {
  const root = useBrainUiRoot();
  useEffect(() => root.connection.connect(), [root]);
  const send = useCallback((message: ClientMessage) => root.connection.send(message), [root]);
  return { send };
}
