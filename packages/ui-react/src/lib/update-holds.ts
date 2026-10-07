import type { BrainUiServices } from "../root.js";
import { holdsUnsaved } from "../stores/draft-state.js";
import { anyStagedTracks, subscribeAllTracks } from "./draft-tracks.js";

/**
 * Work that a service-worker update reload would lose or interrupt (#1015).
 * While any hold registered on a root is busy, `useServiceWorkerUpdates`
 * keeps a pending update takeover from reloading the page; when one reports
 * a change and none is busy any more, the reload fires once.
 *
 * Registered today, per root: an unsaved or unsettled session draft (#951),
 * a staged track (#1112), a live dictation (connecting, listening or
 * draining) and nonempty voice review text. The hook adds its DOM draft
 * probe and the shell's `isBusy`. Later work registers through
 * `registerUpdateHold`: a running local recording (#1012, #1017), a
 * recording being transcribed or holding an unaccepted transcript (#1019,
 * #1021), and an open association or sign-out dialog (#1022).
 */
export interface UpdateHold {
  /** True while a reload would lose or interrupt this work. */
  busy: () => boolean;
  /**
   * Call `onChange` whenever `busy()` may have changed, so a reload held
   * back by this hold is retried once it goes idle. Returns an unsubscribe.
   */
  subscribe: (onChange: () => void) => () => void;
}

type Registry = { holds: Set<() => boolean>; watchers: Set<() => void> };

const registries = new WeakMap<object, Registry>();

function registry(root: BrainUiServices): Registry {
  let reg = registries.get(root.stores);
  if (!reg) { reg = { holds: new Set(), watchers: new Set() }; registries.set(root.stores, reg); }
  return reg;
}

function notify(reg: Registry) {
  for (const watch of [...reg.watchers]) watch();
}

/**
 * Hold this root's update reloads while `hold.busy()` is true. Returns the
 * release, after which the hold no longer counts; releasing a busy hold is
 * itself a transition to idle and may let a pending reload fire.
 */
export function registerUpdateHold(root: BrainUiServices, hold: UpdateHold): () => void {
  const reg = registry(root);
  // Its own entry, called through the hold so a method keeps its receiver.
  const entry = () => hold.busy();
  reg.holds.add(entry);
  const unsubscribe = hold.subscribe(() => notify(reg));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    reg.holds.delete(entry);
    notify(reg);
  };
}

/** @internal Any hold registered on this root is busy. */
export function updateHeld(root: BrainUiServices): boolean {
  for (const busy of registry(root).holds) if (busy()) return true;
  return false;
}

/** @internal Called whenever any hold on this root may have changed. */
export function subscribeUpdateHolds(root: BrainUiServices, fn: () => void): () => void {
  const reg = registry(root);
  reg.watchers.add(fn);
  return () => { reg.watchers.delete(fn); };
}

/** @internal The holds every root carries from its creation. */
export function registerBuiltInUpdateHolds(root: BrainUiServices): void {
  const { drafts, voice } = root.stores;
  // A session's draft the host has not acknowledged, or a send nothing has
  // settled, in any session, on screen or not (#951).
  registerUpdateHold(root, { busy: () => holdsUnsaved(drafts.getState()), subscribe: (fn) => drafts.subscribe(fn) });
  // A staged track in any view: it lives in this page only (#1112).
  registerUpdateHold(root, { busy: () => anyStagedTracks(root), subscribe: (fn) => subscribeAllTracks(root, fn) });
  // A live dictation: the session connecting, the mic listening, or the
  // transcript draining after Done. A reload would cut it off mid-word.
  registerUpdateHold(root, {
    busy: () => { const s = voice.getState(); return s.mode !== "idle" || s.connecting || s.draining; },
    subscribe: (fn) => voice.subscribe(fn),
  });
  // Dictated text waiting in the review card: it is in no text field, so
  // the DOM probe misses it, and it is in no saved draft.
  registerUpdateHold(root, {
    busy: () => voice.getState().reviewText.trim().length > 0,
    subscribe: (fn) => voice.subscribe(fn),
  });
}
