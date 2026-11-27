/**
 * Whether a composer send goes now, waits, is refused with a sentence, or is
 * the typed answer to a waiting question (#4829). The composer's two send
 * paths, its held-send effect and its file check used to write these rules
 * out each; the paths still differ, and each difference is a branch below
 * that names the path it applies to. Nothing here reads a store: the caller
 * gathers the facts.
 */

/** The sentence each refusal shows. One constant per rule. */
export const SEND_HOLD_SENTENCES = {
  failedTrack: "Your draft is kept. Retry or remove the failed track before sending.",
  unstoredFile: "Your draft is kept. Retry or remove the file that wasn't stored before sending.",
  unattachedFiles: "Your draft is kept. Remove the files marked not attached, or choose them again, before sending.",
  refusedSave: "Your draft is kept. The brain refused to save it; change it and try again.",
  unsavedFiles: "Your draft is kept. Its files couldn't be saved with it; remove one and try again.",
  conflict: "Your draft is kept. Choose which version to keep before sending.",
  conflictFiles: "Your draft is kept. Choose which version to keep before sending its files.",
  lastMessage: "Your draft is kept. Send waits until your last message is saved.",
} as const;

/**
 * `direct`: `handleSubmit` without outgoing snapshots. `held`: the effect
 * that releases a held direct send; `handleSubmit` applies the rules after
 * the files when it runs. `snapshot`: `submitSnapshot`.
 */
export type SendPath = "direct" | "held" | "snapshot";

export interface SendHoldDraft {
  /** A file carried from another draft id. */
  foreignFiles: boolean;
  hasFiles: boolean;
  /** The host refused the draft's current edit. */
  refusedThisEdit: boolean;
  /** A save failure other than `unsaved` or `refused`. */
  saveFailed: boolean;
  conflict: boolean;
  /** The host acknowledged the draft's current edit. */
  acknowledged: boolean;
  /** Every image frame the message carries is made; read only when the other file rules pass. */
  framesReady: () => boolean;
  /** The draft's last message is still being saved. */
  waitsForLastMessage: boolean;
}

export interface SendHoldFacts {
  path: SendPath;
  /** Track uploads; the snapshot path never has them. */
  tracks: { failed: boolean; pending: boolean };
  /** The composer's own queued files, not yet bound to a snapshot. */
  queued: { blocking: boolean; pending: boolean };
  draft: SendHoldDraft | null;
  /** The text alone answers a waiting question. */
  answer: boolean;
}

export type SendHold =
  | { kind: "send" }
  | { kind: "pending" }
  | { kind: "blocked"; sentence: string }
  | { kind: "answer" };

const SEND: SendHold = { kind: "send" };
const PENDING: SendHold = { kind: "pending" };
const blocked = (sentence: string): SendHold => ({ kind: "blocked", sentence });

/** The direct path's file rules (the former `composerFilesHold`). */
function filesHold(queued: SendHoldFacts["queued"], d: SendHoldDraft | null): SendHold {
  if (queued.blocking) return blocked(SEND_HOLD_SENTENCES.unstoredFile);
  if (d?.foreignFiles) return blocked(SEND_HOLD_SENTENCES.unattachedFiles);
  if (queued.pending) return PENDING;
  // A draft without files has nothing for these rules to hold.
  if (!d || !d.hasFiles) return SEND;
  // Direct path only: a refused save of the current edit refuses its files.
  if (d.refusedThisEdit) return blocked(SEND_HOLD_SENTENCES.refusedSave);
  if (d.saveFailed) return blocked(SEND_HOLD_SENTENCES.unsavedFiles);
  // Direct path: a conflict refuses only a draft that has files.
  if (d.conflict) return blocked(SEND_HOLD_SENTENCES.conflictFiles);
  // Sent only from an acknowledged revision: the message names it.
  if (!d.acknowledged) return PENDING;
  // An image's frame still being made: the message carries it, so it waits.
  if (!d.framesReady()) return PENDING;
  return SEND;
}

export function sendHold(facts: SendHoldFacts): SendHold {
  const d = facts.draft;
  if (facts.path === "snapshot") {
    if (facts.queued.blocking) return blocked(SEND_HOLD_SENTENCES.unstoredFile);
    if (d?.foreignFiles) return blocked(SEND_HOLD_SENTENCES.unattachedFiles);
    // Snapshot path: a conflict refuses the draft with or without files.
    if (d?.conflict) return blocked(SEND_HOLD_SENTENCES.conflict);
    // Snapshot path: no refused-save rule. A refused save does not hold
    // Send; the send is the next edit, saved again (#4566).
    if (d?.saveFailed) return blocked(SEND_HOLD_SENTENCES.unsavedFiles);
    // Snapshot path: pending queued files are carried by a held snapshot, not waited for here.
  } else {
    if (facts.tracks.failed) return blocked(SEND_HOLD_SENTENCES.failedTrack);
    // Direct path: a pending track holds the send before any file rule.
    if (facts.path === "direct" && facts.tracks.pending) return PENDING;
    const files = filesHold(facts.queued, d);
    if (files.kind === "blocked") return files;
    // Held path: a file refusal wins over a track still pending.
    if (files.kind === "pending" || facts.tracks.pending) return PENDING;
    // Held path: release the send; handleSubmit applies what follows.
    if (facts.path === "held") return SEND;
  }
  // A typed answer goes on its own queue and waits for no draft save (#4567, D38 §1).
  if (facts.answer) return { kind: "answer" };
  if (d?.waitsForLastMessage) return blocked(SEND_HOLD_SENTENCES.lastMessage);
  return SEND;
}
