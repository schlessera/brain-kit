/**
 * What the classifier was confident about, per question (D42 §5).
 *
 * The pass already counts its outcomes, but a count of `kept` has no number
 * behind it: nobody could say how often a candidate lands just under the 0.6
 * swap line, or how far above it the swaps actually sit. This table holds one
 * row per answered question per pass — the candidate kind, the answer, the
 * line it had to clear, and what became of the candidate — so the thresholds
 * can be moved on a distribution instead of on a guess.
 *
 * Two rules the pass's budget depends on:
 *
 * - It is written AFTER the classifier call has resolved, so it takes none of
 *   the 2 s the call gets.
 * - A write that fails is a log line at the caller, never a block the reader
 *   does not get. Nothing renders or replays from these rows.
 *
 * Rows older than {@link CONFIDENCE_RETENTION_MS} are pruned by the next
 * write, which is what keeps a long-running install from carrying years of
 * instrumentation it will never look at.
 *
 * One pass's rows share a `pass_id`, so `(pass_id, candidate_id)` names one
 * candidate. Some questions can only be read that way: the catalogue asks
 * `criteria_first` of every table, including the ones the shape answer calls
 * `data`, where the question means nothing — read unconditioned, its answers
 * are two populations stacked on top of each other.
 */

import type { Database } from "bun:sqlite";
import type { QuestionObservation } from "@schlessera/brain-ui-sdk/internal";

/** How long a recorded confidence is kept. Long enough to tune on, bounded. */
const CONFIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Record one pass's answers. All-or-nothing, so a partial pass never skews a
 * distribution, and pruned in the same transaction.
 */
export function recordQuestionConfidence(
  db: Database,
  sessionId: string,
  observations: readonly QuestionObservation[],
  now: number = Date.now()
): void {
  if (observations.length === 0) return;
  // One id for this pass, so a candidate's answers can be joined back to each
  // other. Minted rather than derived from the clock: the pass is fire and
  // forget, so one session's slow pass can still be writing when the next
  // turn's starts, and a timestamp does not separate them.
  const passId = crypto.randomUUID();
  const insert = db.prepare(
    `INSERT INTO classification_confidence
       (session_id, pass_id, candidate_id, recorded_at, candidate_kind, question, answer_type, choice, confidence, threshold, cleared, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const prune = db.prepare("DELETE FROM classification_confidence WHERE recorded_at < ?");
  // `.immediate` takes the write lock up front. A deferred transaction that
  // starts reading and upgrades on the first INSERT loses the snapshot race to
  // a concurrent writer with SQLITE_BUSY, which busy_timeout does not rescue —
  // the same reason the activity store writes this way.
  db.transaction(() => {
    for (const observation of observations) {
      insert.run(
        sessionId,
        passId,
        observation.candidateId,
        now,
        observation.candidateKind,
        observation.question,
        observation.answerType,
        observation.choice ?? null,
        observation.confidence,
        observation.threshold,
        observation.cleared ? 1 : 0,
        observation.outcome
      );
    }
    prune.run(now - CONFIDENCE_RETENTION_MS);
  }).immediate();
}
