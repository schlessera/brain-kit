import { CLIENT_RELEASE, softwareDetails, type SoftwareInput } from "../../lib/stats/software.js";
import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";
import { useCallback } from "react";
import { composeStatsAnswer, type Fetched, type StatsSection } from "../../lib/stats/compose-stats.js";
import { statsContextText } from "../../lib/stats/context-text.js";

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
    if (command === "stats" && !buffer?.isStreaming) {
      void runStats(root, sessionId);
      return;
    }
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
    }
  }, [root]);
}

/**
 * Brain statistics, answered into the transcript from the kit (#97). Both
 * channels and software status are asked at once and may fail alone: the corpus from
 * `brain stats`, the runtime from the server's own database. The corpus
 * history (`brain stats --history`, #581) is asked beside them and, when it
 * fails, only takes the trends with it. Local software
 * identity remains visible even when the server cannot be reached.
 *
 * The answer is then kept as part of the session (#582): sent to the host,
 * which gives the agent its figures with the next prompt and replays it
 * after a reload. A draft conversation keeps it until its first message
 * starts a session. When it cannot be sent, it stays on screen and says so.
 */
export async function runStats(root: BrainUiRoot, sessionId: string | null): Promise<void> {
  const epoch = root.authLock.epoch();
  const current = () => root.authLock.epoch() === epoch && root.authLock.state.getState().phase === "active";
  if (!current()) return;
  const chat = root.stores.chat.getState();
  chat.addUserMessage(sessionId, "Stats");
  chat.startAssistantMessage(sessionId);
  const client = { release: CLIENT_RELEASE, sourceCommit: root.config.sourceCommit };
  // Local identity is useful even while every network request is still pending.
  chat.setStatsAnswer(sessionId, [{ kind: "software", details: { ...softwareDetails({
    client, server: { ok: false, error: "checking server" },
  }), state: "Checking server", detail: "The client identity below belongs to this loaded bundle." } }]);
  try {
    const [corpus, runtime, status, history] = await Promise.all([
      settle(root.api.brainStats(), (v) => typeof v.health === "object" && v.health !== null),
      settle(root.api.activityStats(), (v) => typeof v.window === "object" && v.window !== null),
      settle(root.api.status(), () => true),
      settle(root.api.brainStatsHistory(), (v) => Array.isArray(v.dates)),
    ]);
    if (!current()) return;
    const server: SoftwareInput["server"] = status.ok ? {
      ok: true, value: {
        release: status.value.software?.release ?? null,
        sourceCommit: status.value.software?.sourceCommit ?? status.value.version ?? null,
      },
    } : status;
    const sections = composeStatsAnswer({ corpus, runtime, history, software: { client, server } });
    root.stores.chat.getState().setStatsAnswer(sessionId, sections);
    keepStatsExchange(root, sessionId, sections);
  } catch (err) {
    if (!current()) return;
    // A figure the composer could not read: say so rather than leave a
    // finished message with nothing in it.
    root.stores.chat.getState().appendText(
      sessionId,
      `**Error:** ${err instanceof Error ? err.message : "Could not draw the statistics"}`
    );
  } finally {
    if (current()) root.stores.chat.getState().finishAssistantMessage(sessionId);
  }
}

/** Hand a finished /stats answer to the host, or keep it with the draft (#582). */
function keepStatsExchange(root: BrainUiRoot, sessionId: string | null, sections: StatsSection[]): void {
  const chat = root.stores.chat.getState();
  const exchange = {
    id: newExchangeId(),
    command: "stats",
    prompt: "Stats",
    answer: sections,
    context: statsContextText(sections),
  };
  if (sessionId === null) {
    chat.setLocalExchange(null, { ...exchange, saved: "draft" });
    return;
  }
  chat.setLocalExchange(sessionId, { ...exchange, saved: "pending" });
  const sent = root.connection.send({ type: "local_exchange", sessionId, exchange });
  if (!sent) {
    chat.markLocalExchange(exchange.id, "unsaved", "There is no connection to the server.");
  }
}

function newExchangeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `x-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
