import type { ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { TrackerState, TrackerView } from "./trackers.js";

/** The three states a tracker announces when it changes into one (D52 §3). */
export type AnnouncedState = Extract<TrackerState, "needs_you" | "failed" | "done">;

const ANNOUNCED: ReadonlySet<TrackerState> = new Set<AnnouncedState>(["needs_you", "failed", "done"]);

/** States that say only that the work could not be read; they never become the baseline a change is measured from. */
const UNREAD: ReadonlySet<TrackerState> = new Set<TrackerState>(["cant_check", "unknown"]);

export interface TrackerAnnouncement {
  sessionId: string;
  state: AnnouncedState;
  outcome: ActivitySpanOutcome | null;
}

/**
 * Decides which tracker changes are announced (D52 §3: once, politely, when
 * one changes to `needs you`, `failed` or `done`; changes into running or
 * queued are not announced).
 *
 * A change is a different state, or the same state for a different turn,
 * from the last one this page saw settle. So repeated frames, ticking ages
 * and a re-read that says the same thing announce nothing, and neither does
 * anything before a tracker's view is `settled` (nothing has answered for it
 * yet).
 *
 * A read that could not answer (`can't check`) or that contradicted what was
 * known (`unknown`) says nothing new about the work, so it does not replace
 * the state last seen to settle (#3414). The read after it that says the same
 * thing again (the same failure of the same turn) announces nothing. Work
 * that moved on during the gap is still a change.
 *
 * The first settled view of a tracker is its baseline, not a change: a
 * tracker restored on load, taken in from another tab, or made by leaving a
 * session the reader was looking at says what was already the case. The one
 * exception is work that starts in a session nobody is watching
 * (`background`): there the reader has seen nothing, so a first view that is
 * already `needs you`, `failed` or `done` is the change.
 */
export function createTrackerAnnouncer() {
  const last = new Map<string, { state: TrackerState; turnId: string | null }>();
  const fresh = new Set<string>();
  return {
    /** Work started in `sessionId` while another session was in view; call before it is tracked. */
    background(sessionId: string): void {
      if (!last.has(sessionId)) fresh.add(sessionId);
    },
    /** The current trackers; returns what to announce, in display order. */
    observe(views: readonly TrackerView[]): TrackerAnnouncement[] {
      const out: TrackerAnnouncement[] = [];
      const present = new Set<string>();
      for (const view of views) {
        present.add(view.sessionId);
        if (!view.settled) continue;
        const before = last.get(view.sessionId);
        if (before !== undefined && UNREAD.has(view.state)) continue;
        last.set(view.sessionId, { state: view.state, turnId: view.turnId });
        const first = before === undefined;
        const wasFresh = fresh.delete(view.sessionId);
        const changed = first ? wasFresh : before.state !== view.state || before.turnId !== view.turnId;
        if (!changed || view.cleared || !ANNOUNCED.has(view.state)) continue;
        out.push({ sessionId: view.sessionId, state: view.state as AnnouncedState, outcome: view.outcome });
      }
      // A tracker that went (seen, acknowledged, or the set deleted) starts
      // over: if the session is tracked again, its first view is a baseline.
      for (const id of [...last.keys()]) if (!present.has(id)) last.delete(id);
      return out;
    },
  };
}

const FAILED: Partial<Record<ActivitySpanOutcome, string>> = {
  interrupted: "was interrupted",
  timeout: "timed out",
};

/** The words: `Tax folder cleanup needs you.` (D52 §3). */
export function announcementText(a: TrackerAnnouncement, label: string): string {
  if (a.state === "needs_you") return `${label} needs you.`;
  if (a.state === "failed") return `${label} ${(a.outcome && FAILED[a.outcome]) || "failed"}.`;
  return `${label} is done.`;
}
