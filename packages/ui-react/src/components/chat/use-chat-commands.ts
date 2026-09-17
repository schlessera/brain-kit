import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";
import { useCallback } from "react";

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
  const root = useBrainUiRoot();
  return useCallback((command: string) => {
    const ui = root.stores.ui.getState();

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

    const chat = root.stores.chat.getState();
    const sessionId = chat.activeSessionId;
    const buffer = sessionId ? chat.buffers[sessionId] : chat.draft;
    const disabled =
      root.stores.connection.getState().wsStatus !== "connected" ||
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
        void runStats(root, sessionId);
        break;
    }
  }, [root]);
}

/** Brain statistics rendered into the transcript as an assistant turn. */
async function runStats(root: BrainUiRoot, sessionId: string | null): Promise<void> {
  const chat = root.stores.chat.getState();
  chat.addUserMessage(sessionId, "Stats");
  chat.startAssistantMessage(sessionId);
  try {
    const stats = await root.api.brainStats();
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
    root.stores.chat.getState().appendText(sessionId, result);
  } catch (err) {
    root.stores.chat.getState()
      .appendText(
        sessionId,
        `**Error:** ${err instanceof Error ? err.message : "Action failed"}`
      );
  } finally {
    root.stores.chat.getState().finishAssistantMessage(sessionId);
  }
}
