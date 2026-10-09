import type { DraftStore } from "../stores/draft-state.js";

/** One pending operation's draft ownership, independent of later navigation. */
export function followDraftTarget(store: DraftStore, draftId: string, sessionId: string | null) {
  let target = store.getState().resolveTarget(draftId, sessionId);
  const dispose = store.subscribe(state => { target = state.resolveTarget(target.draftId, target.sessionId); });
  return { current: () => target, dispose };
}
