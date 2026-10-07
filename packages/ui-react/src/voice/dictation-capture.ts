// Who owns a root's dictation, and the one store update that ends it.
// Shared by `useDictation` (Done, cancel, teardown) and the built-in ASR
// registrations (the provider ending a dictation on its own, #1189), which
// cannot import the hook without a cycle.

import type { AsrClient } from "@schlessera/brain-ui-sdk/client";
import type { BrainUiRoot } from "../root.js";

type VoiceStore = BrainUiRoot["stores"]["voice"];

/**
 * One dictation a `useDictation` hook started, on the root it started it
 * on, with the client capturing it once one exists.
 */
export type Capture = { root: object; client: AsrClient | null };

/**
 * The dictation each root's voice store is showing, by the capture that
 * started it. A hook torn down while it owns its root's dictation ends it in
 * the store (#1015); one that a newer start, another hook, or a pending
 * stop() has taken over leaves it alone.
 */
export const owners = new WeakMap<object, Capture>();
/** Captures a stop() has taken over: it ends them, not a teardown. */
export const stopping = new WeakSet<Capture>();

export function release(capture: Capture) {
  if (owners.get(capture.root) === capture) owners.delete(capture.root);
}

/**
 * End the dictation in one update. With `commitToReview`, what was heard,
 * final and interim, joins any text already under review, so a prompt can be
 * built up across several takes. One update: the transcript reaches review
 * in the same change that ends the dictation, so no listener (the update
 * reload guard, #1015) sees a moment in which it is in neither.
 */
export function endDictation(voice: VoiceStore, commitToReview: boolean): void {
  const { finalText, partial, reviewText } = voice.getState();
  const merged = [finalText, partial].filter(Boolean).join(" ").trim();
  voice.setState({
    connecting: false,
    draining: false,
    mode: "idle",
    finalText: "",
    partial: "",
    audioLevel: 0,
    ...(commitToReview && merged ? { reviewText: reviewText ? `${reviewText} ${merged}` : merged } : {}),
  });
}

/**
 * The provider ended `client`'s capture on its own: its socket closed or
 * the recognizer stopped without a stop() (#1189). What was heard goes to
 * review, as Done would hand it. A client whose dictation a stop(), a
 * teardown or a newer start has already taken over ends nothing.
 */
export function providerEnded(stores: BrainUiRoot["stores"], client: AsrClient): void {
  const capture = owners.get(stores);
  if (!capture || capture.client !== client || stopping.has(capture)) return;
  release(capture);
  endDictation(stores.voice, true);
}
