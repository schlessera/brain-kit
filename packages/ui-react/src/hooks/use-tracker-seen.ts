import { useEffect, type RefObject } from "react";
import { useBrainUiRoot } from "../root-context.js";
import type { BrainUiRoot } from "../root.js";
import { emptyEvidence, isCleared, seenKey } from "../lib/trackers.js";

/** The transcript's own "at the bottom" test (`handleScroll`, chat-page.tsx). */
const AT_BOTTOM_PX = 20;

/**
 * Whether the reader can see the active session's latest turn right now
 * (D52 §4, "Seen"): the session is in view in Chat with nothing over it,
 * the document is visible, the transcript ends on the message the host
 * linked to the latest turn, and that end is in the viewport by the
 * transcript's own bottom test, with no scroll disc drawn. Selecting the
 * session, being scrolled up, a hidden tab, a background buffer and a
 * replay without the linked turn do not count.
 */
export function observeTrackerSeen(root: BrainUiRoot, transcript: HTMLElement | null, scrollDisc: boolean): boolean {
  const chat = root.stores.chat.getState();
  const sessionId = chat.activeSessionId;
  if (sessionId === null || !transcript || scrollDisc) return false;
  const trackers = root.stores.trackers.getState();
  const record = trackers.records[sessionId];
  if (!record) return false;
  const evidence = trackers.evidence[sessionId] ?? emptyEvidence(record.revision);
  if (isCleared(record, evidence)) return false;
  const key = seenKey(record, evidence);
  if (!key) return false;
  const ui = root.stores.ui.getState();
  if (ui.activeView !== "chat" || ui.subagentStack.length > 0) return false;
  if (ui.sessionPanelOpen || ui.filePanelOpen || ui.settingsPanelOpen || ui.syncPanelOpen || ui.whatsupPanelOpen || ui.searchPanelOpen || ui.addPanelOpen) return false;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
  const last = chat.buffers[sessionId]?.messages.at(-1);
  if (!last || last.turnId !== key.turnId) return false;
  if (transcript.clientHeight === 0) return false;
  if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight >= AT_BOTTOM_PX) return false;
  return trackers.observeSeen({ sessionId, ...key });
}

/**
 * Run the seen observer after every committed render of the transcript, on
 * every scroll and whenever the document becomes visible. It writes only
 * the tracker's `seen` marker; it never changes the view.
 */
export function useTrackerSeen(transcript: RefObject<HTMLElement | null>, scrollDisc: boolean): void {
  const root = useBrainUiRoot();
  useEffect(() => {
    observeTrackerSeen(root, transcript.current, scrollDisc);
  });
  useEffect(() => {
    const check = () => observeTrackerSeen(root, transcript.current, scrollDisc);
    const el = transcript.current;
    el?.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    // Evidence arriving while the reader is already at the bottom (the
    // envelope naming the turn, a result) is a new chance to see it.
    const unsubscribe = root.stores.trackers.subscribe(check);
    return () => {
      el?.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
      unsubscribe();
    };
  });
}
