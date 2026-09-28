import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";
import { useCallback } from "react";
import { composeStatsAnswer, type Fetched } from "./stats/compose-stats.js";

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

/**
 * Brain statistics, answered into the transcript from the kit (#97). Both
 * channels are asked at once and either may fail alone: the corpus from
 * `brain stats`, the runtime from the server's own database. Only when both
 * fail does the answer fall back to one error line.
 */
export async function runStats(root: BrainUiRoot, sessionId: string | null): Promise<void> {
  const chat = root.stores.chat.getState();
  chat.addUserMessage(sessionId, "Stats");
  chat.startAssistantMessage(sessionId);
  try {
    const [corpus, runtime] = await Promise.all([
      settle(root.api.brainStats(), (v) => typeof v.health === "object" && v.health !== null),
      settle(root.api.activityStats(), (v) => typeof v.window === "object" && v.window !== null),
    ]);
    const store = root.stores.chat.getState();
    if (!corpus.ok && !runtime.ok) {
      store.appendText(sessionId, `**Error:** ${corpus.error}`);
    } else {
      store.setStatsAnswer(sessionId, composeStatsAnswer({ corpus, runtime }));
    }
  } catch (err) {
    // A figure the composer could not read: say so rather than leave a
    // finished message with nothing in it.
    root.stores.chat.getState().appendText(
      sessionId,
      `**Error:** ${err instanceof Error ? err.message : "Could not draw the statistics"}`
    );
  } finally {
    root.stores.chat.getState().finishAssistantMessage(sessionId);
  }
}

/** A channel's answer, or why there is none: a rejection, or a body that is not the shape asked for. */
async function settle<T>(request: Promise<T>, shaped: (value: T) => boolean): Promise<Fetched<T>> {
  try {
    const value = await request;
    if (value === null || typeof value !== "object" || !shaped(value)) {
      return { ok: false, error: "the server returned no figures" };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Action failed" };
  }
}
