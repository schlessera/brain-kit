import { useCallback } from "react";
import { useBrainUiRoot } from "../root-context.js";

/**
 * Switch the chat view to a stored session and load its history — what the
 * session list does on a tap. The handoff card's `Open ›`, the source's
 * forward marker and a recovered handoff (#61) open sessions the same way.
 */
export function useOpenSession(): (sessionId: string) => void {
  const root = useBrainUiRoot();
  return useCallback(
    (sessionId: string) => {
      const chat = root.stores.chat.getState();
      chat.clearMessages();
      chat.setActiveSession(sessionId);
      root.stores.ui.getState().setActiveView("chat");
      root.connection.send({ type: "session_resume", sessionId });
    },
    [root]
  );
}
