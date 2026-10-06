/**
 * Where pill labels (#1004) are asked for and where they land.
 *
 * - A queued follow-up is labelled from its own text when it joins a queue.
 *   The label rides its `QueuedFollowUpView`, so the session's queue report
 *   is sent again once it arrives, and every later report (a reload, a
 *   reconnect) carries it without asking again.
 * - A session is labelled from its latest request when a turn starts, and
 *   the label is stored on its catalog row with a hash of that request, so
 *   the session list carries it across reloads and restarts. The same
 *   request is never labelled twice, and a follow-up that becomes its
 *   session's turn reuses the answer its pill already had.
 *
 * Neither path is awaited: the pill shows its fallback until then.
 */
import type { Labeller } from "./labeller.js";
import { labelSourceHash } from "./labeller.js";
import type { SessionCatalog } from "../ws/session-catalog.js";
import type { QueuedFollowUp, TurnCoordinator } from "../ws/turns.js";

export interface PillLabels {
  /** A follow-up just joined `sessionId`'s queue. */
  followUpQueued(sessionId: string, entry: QueuedFollowUp): void;
  /** A turn carrying `text` was just handed to the agent for `sessionId`. */
  turnStarted(sessionId: string, text: string): void;
}

export function createPillLabels(deps: {
  labeller: Labeller;
  catalog: SessionCatalog;
  coordinator: TurnCoordinator;
}): PillLabels {
  const { labeller, catalog, coordinator } = deps;
  // The request each session was last labelled for, so a slow answer for an
  // older request never replaces a newer one.
  const latest = new Map<string, string>();

  return {
    followUpQueued(sessionId, entry) {
      if (!labeller.enabled || entry.label || !entry.followUpId || !entry.text.trim()) return;
      const id = entry.followUpId;
      void labeller.label(`follow-up:${id}`, entry.text).then((label) => {
        // Only a follow-up still waiting gets one: a started or dropped
        // entry has left every report.
        if (!label || !coordinator.pendingFollowUps(sessionId).includes(entry)) return;
        entry.label = label;
        coordinator.queueChanged(sessionId);
      });
    },

    turnStarted(sessionId, text) {
      if (!labeller.enabled || !catalog.saveSessionLabel || !text.trim()) return;
      const source = labelSourceHash(text);
      // Already labelled for this request: an older request still being
      // labelled must not replace it when its answer arrives.
      if (catalog.sessionLabel?.(sessionId)?.source === source) {
        latest.delete(sessionId);
        return;
      }
      latest.set(sessionId, source);
      void labeller.label(`session:${sessionId}`, text).then((label) => {
        if (latest.get(sessionId) !== source) return;
        latest.delete(sessionId);
        if (label) catalog.saveSessionLabel?.(sessionId, label, source);
      });
    },
  };
}
