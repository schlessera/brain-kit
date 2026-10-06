import { useEffect, type RefObject } from "react";
import { useBrainUiRoot, useRootStore } from "../root-context.js";
import type { BrainUiRoot } from "../root.js";
import { evidenceFromRecord, isCleared, seenKey } from "../lib/trackers.js";

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
  const evidence = trackers.evidence[sessionId] ?? evidenceFromRecord(record);
  if (isCleared(record, evidence)) return false;
  const key = seenKey(record, evidence);
  if (!key) return false;
  const ui = root.stores.ui.getState();
  if (ui.activeView !== "chat" || ui.subagentStack.length > 0) return false;
  if (ui.sessionPanelOpen || ui.filePanelOpen || ui.settingsPanelOpen || ui.syncPanelOpen || ui.whatsupPanelOpen || ui.searchPanelOpen || ui.addPanelOpen || ui.paletteOpen) return false;
  // The other modal surfaces that cover Chat: the mask editor and the handoff sheet.
  if (root.stores.mask.getState().request || root.stores.handoff.getState().sheet) return false;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;
  // And any open modal dialog (a zoom viewer, a one-time credential, a sheet).
  if (typeof document.querySelector === "function" && document.querySelector('[aria-modal="true"]')) return false;
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
  // Evidence arriving while the reader is already at the bottom (the
  // envelope naming the turn, a result) is a new chance to see it. It is
  // read through a render, never from a store subscriber: a frame updates
  // the transcript and the evidence together, and only after the commit
  // does the DOM show the turn the store already names.
  const sessionId = useRootStore("chat", (s) => s.activeSessionId);
  useRootStore("trackers", (s) => (sessionId ? s.evidence[sessionId] : undefined));
  useRootStore("trackers", (s) => (sessionId ? s.records[sessionId] : undefined));
  // Something that covered Chat going away is a chance too.
  useRootStore("ui", (s) => `${s.activeView}:${s.paletteOpen}:${s.subagentStack.length}`);
  useRootStore("mask", (s) => s.request !== null);
  useRootStore("handoff", (s) => s.sheet !== null);
  useEffect(() => {
    observeTrackerSeen(root, transcript.current, scrollDisc);
  });
  // While this session has a tracker to clear, a modal dialog closing
  // (they mount and unmount under the body) is a chance too.
  const waiting = useRootStore("trackers", (s) => !!sessionId && !!s.records[sessionId] && !isCleared(s.records[sessionId]!, s.evidence[sessionId] ?? evidenceFromRecord(s.records[sessionId])));
  useEffect(() => {
    if (!waiting || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(() => observeTrackerSeen(root, transcript.current, scrollDisc));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
    return () => observer.disconnect();
  });
  useEffect(() => {
    const check = () => observeTrackerSeen(root, transcript.current, scrollDisc);
    const el = transcript.current;
    el?.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    return () => {
      el?.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
    };
  });
}
