import { useCallback } from "react";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { api } from "../../lib/api-client.js";

/**
 * Slash-command dispatch, shared by the composer's palette and the welcome
 * screen's shortcut buttons.
 *
 * Every piece of state a command needs is read through `getState()` at the
 * moment it runs rather than subscribed to, so the returned callback is stable
 * for the life of the component. That matters because the composer is the
 * component that re-renders on every keystroke: a command handler that changed
 * identity per character would defeat the memoization around it.
 */
export function useChatCommands(): (command: string) => void {
  return useCallback((command: string) => {
    const ui = useUIStore.getState();

    // Search and add talk to the brain CLI over REST, not to the agent — they
    // stay available while a turn streams or the socket is down.
    switch (command) {
      case "search":
        ui.setSearchPanelOpen(true);
        return;
      case "add":
        ui.setAddPanelOpen(true);
        return;
    }

    const chat = useChatStore.getState();
    const sessionId = chat.activeSessionId;
    const buffer = sessionId ? chat.buffers[sessionId] : chat.draft;
    const disabled =
      useConnectionStore.getState().wsStatus !== "connected" ||
      Boolean(buffer?.isStreaming);
    if (disabled) return;

    switch (command) {
      case "sync":
        ui.setSyncPanelOpen(true);
        break;
      case "whatsup":
        ui.setWhatsupPanelOpen(true);
        break;
      case "stats":
        void runStats(sessionId);
        break;
    }
  }, []);
}

/** Brain statistics rendered into the transcript as an assistant turn. */
async function runStats(sessionId: string | null): Promise<void> {
  const chat = useChatStore.getState();
  chat.addUserMessage(sessionId, "Stats");
  chat.startAssistantMessage(sessionId);
  try {
    const stats = await api.brainStats();
    const result = [
      `**Brain Statistics**`,
      `- Documents: ${stats.documents}`,
      `- Tags: ${stats.tags}`,
      `- Links: ${stats.links}`,
      ``,
      `**By Type:** ${Object.entries(stats.byType)
        .sort(([, a], [, b]) => b - a)
        .map(([t, n]) => `${t} (${n})`)
        .join(", ")}`,
      ``,
      `**By Status:** ${Object.entries(stats.byStatus)
        .map(([s, n]) => `${s} (${n})`)
        .join(", ")}`,
    ].join("\n");
    useChatStore.getState().appendText(sessionId, result);
  } catch (err) {
    useChatStore
      .getState()
      .appendText(
        sessionId,
        `**Error:** ${err instanceof Error ? err.message : "Action failed"}`
      );
  } finally {
    useChatStore.getState().finishAssistantMessage(sessionId);
  }
}
