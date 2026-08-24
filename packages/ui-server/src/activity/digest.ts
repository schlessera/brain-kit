/**
 * The while-you-were-away digest: a deterministic summary rendered from
 * per-run rollups, produced by its OWN scheduled job (through the standard
 * cron wrapper, so its runs land in the record like any other) — never a
 * side effect of instrumentation.
 *
 * The digest's covered-until time is the retention floor: full-detail spans
 * older than the last covered window are prunable, newer ones are not (the
 * hard ceiling in the store bounds a broken digest job regardless). Windows
 * are labeled — the card says WHAT period it covers rather than implying
 * "now". The digest job's own runs are recorded but excluded from the
 * notable list, or every digest would feature itself.
 */
import type { Database } from "bun:sqlite";
import { isFailureOutcome, type ActivityDigest } from "@schlessera/brain-ui-sdk/protocol";

import { getSetting, setSetting } from "../db/settings.js";
import { rowToRunRollup } from "./store.js";

export type { ActivityDigest } from "@schlessera/brain-ui-sdk/protocol";

export const DIGEST_LATEST_KEY = "activity.digest.latest";
export const DIGEST_COVERED_KEY = "activity.digest.coveredUntil";
export const DIGEST_DISMISSED_KEY = "activity.digest.dismissedAt";
export const DIGEST_JOB_NAME = "digest";

/** First run ever: no covered-until marker — cap the window at 24h. */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Generate and persist the digest for [coveredUntil, now]. */
export function generateActivityDigest(db: Database, now = Date.now()): ActivityDigest {
  const covered = getSetting<number | null>(db, DIGEST_COVERED_KEY, null);
  const windowStart = covered ?? now - FIRST_WINDOW_MS;

  // Windowed on ended_at, not started_at: every FINISHED run gets
  // exactly-once coverage — a run still open at generation is picked up by
  // the NEXT digest once it ends, instead of falling between windows.
  const rows = (
    db
      .query(
        `SELECT * FROM activity_run_rollups
         WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?
         ORDER BY started_at DESC`
      )
      .all(windowStart, now) as any[]
  ).map(rowToRunRollup);

  const relevant = rows.filter((r) => r.jobName !== DIGEST_JOB_NAME);
  const failures = relevant.filter((r) => isFailureOutcome(r.outcome));

  const digest: ActivityDigest = {
    generatedAt: now,
    windowStart,
    windowEnd: now,
    runs: relevant.length,
    failures: failures.length,
    costUsd: relevant.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    inputTokens: relevant.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
    outputTokens: relevant.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    notable: failures.slice(0, 10).map((r) => ({
      runId: r.runId,
      name: r.name,
      jobName: r.jobName,
      sessionId: r.sessionId,
      outcome: r.outcome,
      failureReason: r.failureReason,
      startedAt: r.startedAt,
    })),
  };

  setSetting(db, DIGEST_LATEST_KEY, digest);
  setSetting(db, DIGEST_COVERED_KEY, now);
  return digest;
}

/** The latest digest, or null before the first run. */
export function latestActivityDigest(db: Database): ActivityDigest | null {
  return getSetting<ActivityDigest | null>(db, DIGEST_LATEST_KEY, null);
}

/** The retention floor: never prune spans the digest has not covered. */
export function digestRetentionFloor(db: Database): number {
  return getSetting<number>(db, DIGEST_COVERED_KEY, 0);
}

export function dismissActivityDigest(db: Database, at = Date.now()): void {
  setSetting(db, DIGEST_DISMISSED_KEY, at);
}

export function digestDismissedAt(db: Database): number {
  return getSetting<number>(db, DIGEST_DISMISSED_KEY, 0);
}
