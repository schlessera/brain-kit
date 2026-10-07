import { useCallback, useSyncExternalStore } from "react";
import { useBrainUiRoot } from "../root-context.js";
import { stagedTrackViews, subscribeAllTracks, type StagedTracks } from "../lib/draft-tracks.js";

/** Every nonempty staged-track queue of this root, redrawn on any queue's change (#1112). */
export function useStagedTracks(): StagedTracks[] {
  const root = useBrainUiRoot();
  const subscribe = useCallback((fn: () => void) => subscribeAllTracks(root, fn), [root]);
  const snapshot = useCallback(() => stagedTrackViews(root), [root]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
