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
 */

import type { Database } from "bun:sqlite";
import type { QuestionObservation } from "@schlessera/brain-ui-sdk/server";

/** How long a recorded confidence is kept. Long enough to tune on, bounded. */
export const CONFIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How many buckets the 0-1 range is cut into for the distribution. */
export const CONFIDENCE_BUCKETS = 10;

/** How wide one of those buckets is. */
export const CONFIDENCE_BUCKET_WIDTH = 1 / CONFIDENCE_BUCKETS;

/**
 * One bucket of the distribution: how many answers to this question about
 * this candidate kind landed in it, how many cleared their threshold, and how
 * many belonged to a candidate that was drawn as a block.
 */
export interface ConfidenceBucket {
  candidateKind: string;
  question: string;
  /** The line these rows were compared against, or null when ungated. */
  threshold: number | null;
  /** The bucket's lower bound: 0.6 covers [0.6, 0.7). */
  bucket: number;
  count: number;
  cleared: number;
  swapped: number;
}

export interface ConfidenceReadOptions {
  /** Only rows recorded at or after this epoch-ms. Default: everything kept. */
  since?: number;
}

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
  const insert = db.prepare(
    `INSERT INTO classification_confidence
       (session_id, recorded_at, candidate_kind, question, answer_type, choice, confidence, threshold, cleared, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const prune = db.prepare("DELETE FROM classification_confidence WHERE recorded_at < ?");
  db.transaction(() => {
    for (const observation of observations) {
      insert.run(
        sessionId,
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
  })();
}

/**
 * The distribution, bucketed 0.1 wide, per candidate kind and question. The
 * grouping keeps the threshold, so rows recorded either side of a threshold
 * change are not averaged together.
 */
export function confidenceDistribution(
  db: Database,
  options: ConfidenceReadOptions = {}
): ConfidenceBucket[] {
  const rows = db
    .query(
      // The bucket index is computed in SQL so the grouping can use it; the
      // only interpolation is this module's own constant.
      `SELECT candidate_kind AS candidateKind,
              question,
              threshold,
              CAST(MAX(0, MIN(confidence, 0.99999)) * ${CONFIDENCE_BUCKETS} AS INTEGER) AS bucket,
              COUNT(*) AS count,
              SUM(cleared) AS cleared,
              SUM(outcome = 'swapped') AS swapped
         FROM classification_confidence
        WHERE recorded_at >= ?
        GROUP BY candidate_kind, question, threshold, bucket
        ORDER BY candidate_kind, question, threshold, bucket`
    )
    .all(options.since ?? 0) as Array<Omit<ConfidenceBucket, "bucket"> & { bucket: number }>;
  // The bucket comes back as its index; the caller wants its lower bound.
  return rows.map((row) => ({ ...row, bucket: row.bucket / CONFIDENCE_BUCKETS }));
}
