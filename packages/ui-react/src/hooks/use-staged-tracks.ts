import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { anyStagedTracks, stagedTrackViews, subscribeAllTracks, type StagedTracks } from "../lib/draft-tracks.js";

/** Every nonempty staged-track queue of this root, redrawn on any queue's change (#1112). */
export function useStagedTracks(): StagedTracks[] {
  const root = useBrainUiRoot();
  const subscribe = useCallback((fn: () => void) => subscribeAllTracks(root, fn), [root]);
  const snapshot = useCallback(() => stagedTrackViews(root), [root]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Staged tracks live in this page only (D52 §5), so while any queue of this
 * root holds one, in any view and any upload state, leaving the page asks the
 * browser to confirm (#1150). The browser draws its own words, and may skip
 * the prompt on a page the user never interacted with.
 *
 * The handler is added and removed as the queues change, from the same
 * all-queues subscription the update hold uses, not from a render. It also
 * reads the queues when the page is leaving, so a takeover reload fired by
 * another watcher of the same change never meets a stale handler.
 */
export function useStagedTracksUnloadGuard(): void {
  const root = useBrainUiRoot();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const protect = (event: BeforeUnloadEvent) => {
      if (!anyStagedTracks(root)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    let added = false;
    const sync = () => {
      const staged = anyStagedTracks(root);
      if (staged === added) return;
      added = staged;
      if (staged) window.addEventListener("beforeunload", protect);
      else window.removeEventListener("beforeunload", protect);
    };
    const unsubscribe = subscribeAllTracks(root, sync);
    sync();
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", protect);
    };
  }, [root]);
}
