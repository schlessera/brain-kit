/**
 * The media count `brain sync` reports (#2780), from the same inventory,
 * fingerprints and disposition predicates hygiene review uses, read offline
 * from the brain's own files: the working tree, `context/hygiene/` and the
 * scratch pin snapshot. Nothing here writes, reconciles or reads server state.
 */

import { canonicalFindings, mediaReviewCounts, readHygieneLog, type HygieneLogEntry } from "./hygiene.js";
import type { MediaPolicy } from "./media.js";
import { mediaCandidates, mediaInventory, pinnedPathLimit, readScratchPins, type ScratchPins } from "./media-inventory.js";
import { mediaReferenceLimits, type MediaReferenceScanOptions } from "./media-references.js";
import type { AssessedFile } from "./sync/artifacts.js";
import { resolveEnv } from "../config/env.js";

/** `run.leftovers.mediaPending` and `mediaSetAside`. */
export interface SyncMediaCounts {
  pending: number;
  setAside: { dismissed: number; snoozed: number; kept: number };
}

/**
 * Count `assessed` (one sync assessment) against the hygiene log at `now`.
 * Pinned scratch files are review-only and never counted; the pins are read
 * only so an assessed scratch file has the fingerprint review gives it. A
 * log that cannot be read leaves no disposition in force, so the count
 * errs towards files awaiting review, never towards "all decided".
 */
export function syncMediaCounts(root: string, policy: MediaPolicy, assessed: readonly AssessedFile[], now: Date): SyncMediaCounts {
  let pins: ScratchPins;
  try {
    pins = readScratchPins(root, pinnedPathLimit(resolveEnv().mediaPinnedPathLimit));
  } catch {
    pins = { state: "unknown", sessions: new Map(), observed: 0, limit: 0 };
  }
  // The same reference bounds review uses, so both fingerprint a file alike.
  // Invalid bounds stop review's detection; here the scan is refused instead,
  // so the count stays truthful and nothing claims references were checked.
  let references: MediaReferenceScanOptions;
  try {
    references = { limits: mediaReferenceLimits(resolveEnv().mediaReferenceLimits) };
  } catch {
    references = { limits: { notes: 0, noteBytes: 1, perNote: 1, scanTime: 1, refsPerFinding: 1, rewrittenNotes: 1, preview: 1 } };
  }
  const findings = canonicalFindings(mediaCandidates(mediaInventory(root, policy, assessed, pins, references)));
  let entries: HygieneLogEntry[] = [];
  try {
    entries = readHygieneLog(root);
  } catch {
    entries = [];
  }
  const counts = mediaReviewCounts(root, policy, findings, entries, now);
  return { pending: counts.awaitingReview, setAside: { dismissed: counts.dismissed, snoozed: counts.snoozed, kept: counts.kept } };
}

/**
 * The routine report's one media line (rev 6 §2, ruling A): the count, what
 * is set aside and kept when there is any, and the route into review while
 * anything awaits it. Never a path. Null when there is no media at all, so a
 * report without media is unchanged.
 */
export function mediaReportLine(counts: SyncMediaCounts): string | null {
  const setAside = counts.setAside.dismissed + counts.setAside.snoozed;
  if (counts.pending + setAside + counts.setAside.kept === 0) return null;
  return [
    `Media awaiting review: ${counts.pending}`,
    ...(setAside > 0 ? [`${setAside} set aside`] : []),
    ...(counts.setAside.kept > 0 ? [`${counts.setAside.kept} kept as a copy`] : []),
    ...(counts.pending > 0 ? ["review in Actions"] : []),
  ].join(" · ");
}
