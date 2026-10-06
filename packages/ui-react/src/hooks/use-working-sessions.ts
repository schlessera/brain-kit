import { useMemo } from "react";
import type { WorkingSession } from "@schlessera/brain-ui-kit";
import { useRootStore } from "../root-context.js";
import { trackerRow, trackerViews } from "../stores/tracker-state.js";
import type { ChatState } from "../stores/chat-state.js";
import type { ListedSession } from "../stores/session-list-state.js";
import type { TrackerView } from "../lib/trackers.js";

/** One tracker as the strip, its sheet, the drawer and the pane draw it. */
export type WorkingSessionData = Omit<WorkingSession, "onOpen">;

/**
 * What a tracker is called (D52 §3): #1004's few-word label when the host
 * has one, else the session's title (L1 on #1004: `label ?? title`), else
 * the start of the session's first prompt in this page, else `Untitled`.
 * Read from the session list at render time; the tracker record stores no
 * title (D52 §4).
 */
export function trackerLabel(sessionId: string, listed: ListedSession | undefined, chat: Pick<ChatState, "buffers">): string {
  return listed?.label?.trim() || listed?.title?.trim() || firstPrompt(chat, sessionId) || "Untitled";
}

/** The first line of a session's first prompt, when this page holds its transcript. */
function firstPrompt(chat: Pick<ChatState, "buffers">, sessionId: string): string {
  const text = chat.buffers[sessionId]?.messages.find((m) => m.role === "user")?.content ?? "";
  return text.trim().split("\n")[0]?.trim() ?? "";
}

const CANT_CHECK = {
  host_unreachable: "host unreachable",
  host_too_old: "host too old",
  session_not_found: "session not found",
} as const;

/** #948's view of one tracker, in the kit's vocabulary (`WorkingSession`). */
export function workingSession(view: TrackerView, label: string): WorkingSessionData {
  const base = { id: view.sessionId, label, startedAt: view.startedAt, endedAt: view.endedAt };
  switch (view.state) {
    case "needs_you":
      return { ...base, state: "needs-you", ...(view.pendingKind ? { need: view.pendingKind } : {}) };
    case "failed":
      return { ...base, state: "failed", outcome: view.outcome === "interrupted" ? "interrupted" : view.outcome === "timeout" ? "timed out" : "failed" };
    case "cancelled":
      return { ...base, state: "cancelled", outcome: view.outcome === "denied" ? "denied" : "cancelled" };
    case "queued":
      return { ...base, state: "queued", ...(view.queueNote ? { queueNote: view.queueNote } : {}) };
    case "cant_check": {
      const reason = view.cantCheck && view.cantCheck !== "unauthorized" ? CANT_CHECK[view.cantCheck] : undefined;
      return { ...base, state: "cant-check", ...(reason ? { reason } : {}) };
    }
    default:
      return { ...base, state: view.state };
  }
}

export interface WorkingSessions {
  /**
   * The trackers to draw as Working rows and pills, in D52 §4's order: none
   * that is cleared, every live one, and at most 24 done or cancelled.
   */
  shown: WorkingSessionData[];
  /** Done or cancelled past the cap: off the pills, `unseen` on their Sessions row. */
  overflow: ReadonlySet<string>;
  /** Every tracked session's view, cleared or not, by id. */
  views: ReadonlyMap<string, TrackerView>;
}

/**
 * The root's trackers (#948), ready to draw: the pills below 1280, and the
 * Working group of the drawer and of the ≥1280 pane. Labels come from the
 * root's session list.
 */
export function useWorkingSessions(): WorkingSessions {
  const records = useRootStore("trackers", (s) => s.records);
  const evidence = useRootStore("trackers", (s) => s.evidence);
  const unconfirmed = useRootStore("trackers", (s) => s.unconfirmed);
  const recoverySupported = useRootStore("trackers", (s) => s.recoverySupported);
  const queueNotes = useRootStore("chat", (s) => s.queueNotes);
  const sessions = useRootStore("sessions", (s) => s.sessions);
  // Only the fallback labels of tracked sessions, as one string, so a
  // streaming delta does not redraw the pills.
  const prompts = useRootStore("chat", (s) => JSON.stringify(Object.keys(records).map((id) => [id, firstPrompt(s, id)])));
  return useMemo(() => {
    const all = trackerViews({ records, evidence, unconfirmed, recoverySupported }, queueNotes);
    const { shown, overflow } = trackerRow(all);
    const listed = new Map(sessions.map((s) => [s.id, s]));
    const fallback = new Map(JSON.parse(prompts) as Array<[string, string]>);
    const label = (id: string) => listed.get(id)?.label?.trim() || listed.get(id)?.title?.trim() || fallback.get(id) || "Untitled";
    return {
      shown: shown.map((view) => workingSession(view, label(view.sessionId))),
      overflow: new Set(overflow.map((v) => v.sessionId)),
      views: new Map(all.map((v) => [v.sessionId, v])),
    };
  }, [records, evidence, unconfirmed, recoverySupported, queueNotes, prompts, sessions]);
}
