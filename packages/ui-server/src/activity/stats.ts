/**
 * The runtime stats channel: what the server's OWN database says about
 * sessions, runs, tokens and cost. The corpus channel is `brain stats`
 * (`GET /api/brain/stats`, which shells the CLI); this one sits beside it
 * and never reads brain.db — the corpus/runtime split is a hard boundary.
 *
 * Two sources that do not say the same thing, each labelled with what it
 * covers:
 *
 * - `sessions` is lifetime and never pruned: one row per chat session, with
 *   the backend-reported cost and turn count accumulated across its turns.
 * - `activity_run_rollups` is read over a window. A rollup row outlives its
 *   detail (migration 007), so the sums are complete back to the oldest
 *   rollup — but the record starts later than the session catalog (007 vs
 *   001), and drill-in detail older than the retention cutoff is gone. The
 *   window therefore says where the record starts, how many of its days it
 *   can vouch for, where detail stops, and how many of its runs are already
 *   rollup-only.
 *
 * An average is emitted only where the sum it derives from is complete
 * (AE3): the effective-cost averages are null over a window with unpriced
 * runs, because a rate hides the hole that a "≥ $X · N unpriced" sum shows.
 */
import type { Database } from "bun:sqlite";
import type { ActivityRuntimeStats } from "@schlessera/brain-ui-sdk/protocol";

import { getDetailRetentionDays } from "../db/settings.js";
import { rowToRunRollup, summarizeRollups } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mean Gregorian month: per-month is per-day projected, not calendar-bound. */
const DAYS_PER_MONTH = 365.25 / 12;

export const RUNTIME_STATS_DEFAULT_DAYS = 30;
export const RUNTIME_STATS_MAX_DAYS = 90;

export function computeRuntimeStats(
  db: Database,
  opts: { days: number; now?: number }
): ActivityRuntimeStats {
  const now = opts.now ?? Date.now();
  return {
    generatedAt: now,
    lifetime: lifetimeFromSessions(db, now),
    window: windowFromRollups(db, opts.days, now),
    database: { sizeBytes: databaseSizeBytes(db) },
  };
}

function lifetimeFromSessions(db: Database, now: number): ActivityRuntimeStats["lifetime"] {
  const row = db
    .query(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(num_turns), 0) AS turns,
              COALESCE(SUM(total_cost_usd), 0) AS costUsd,
              MIN(created_at) AS firstActivityAt,
              MAX(last_active_at) AS lastActivityAt
       FROM sessions`
    )
    .get() as {
    sessions: number;
    turns: number;
    costUsd: number;
    firstActivityAt: number | null;
    lastActivityAt: number | null;
  };
  // Per-day is a burn rate over the catalog's whole life, idle days
  // included; a catalog younger than a day is averaged over one.
  const elapsedDays =
    row.sessions > 0 && row.firstActivityAt !== null
      ? Math.max(1, (now - row.firstActivityAt) / DAY_MS)
      : 0;
  const perDay = row.sessions > 0 ? row.costUsd / elapsedDays : null;
  return {
    scope: "lifetime",
    sessions: row.sessions,
    turns: row.turns,
    costUsd: row.costUsd,
    firstActivityAt: row.firstActivityAt,
    lastActivityAt: row.lastActivityAt,
    elapsedDays,
    averages: {
      costUsdPerSession: row.sessions > 0 ? row.costUsd / row.sessions : null,
      turnsPerSession: row.sessions > 0 ? row.turns / row.sessions : null,
      costUsdPerDay: perDay,
      costUsdPerMonth: perDay === null ? null : perDay * DAYS_PER_MONTH,
    },
  };
}

function windowFromRollups(
  db: Database,
  days: number,
  now: number
): ActivityRuntimeStats["window"] {
  const since = now - days * DAY_MS;
  // The same fold the query_activity `rollups` scope uses, over the same
  // predicate — one definition of "what a window adds up to".
  const rows = (
    db.query("SELECT * FROM activity_run_rollups WHERE started_at >= ?").all(since) as any[]
  ).map(rowToRunRollup);
  const summary = summarizeRollups(rows);

  const oldest = db
    .query("SELECT MIN(started_at) AS recordedSince FROM activity_run_rollups")
    .get() as { recordedSince: number | null };
  const recordedSince = oldest.recordedSince;
  // A window reaching past the start of the record covers only the days the
  // record can vouch for; a record younger than a day is averaged over one.
  const coveredDays =
    recordedSince === null ? 0 : Math.max(1, (now - Math.max(since, recordedSince)) / DAY_MS);

  const retentionDays = getDetailRetentionDays(db);
  const cutoffAt = now - retentionDays * DAY_MS;

  const perDay = (n: number) => (coveredDays > 0 ? n / coveredDays : null);
  const perMonth = (n: number | null) => (n === null ? null : n * DAYS_PER_MONTH);
  const costUsdPerDay = perDay(summary.costUsd);
  // Only a complete sum may become a rate (AE3).
  const effectiveCostUsdPerDay = summary.unpricedRuns > 0 ? null : perDay(summary.effectiveCostUsd);

  return {
    scope: "window",
    days,
    since,
    until: now,
    recordedSince,
    coveredDays,
    detailRetention: { days: retentionDays, cutoffAt, insideWindow: since < cutoffAt },
    detailPrunedRuns: rows.filter((r) => r.detailPruned).length,
    // Listed, not spread: the summary is an internal fold and this object is
    // a documented wire shape — a field added to the former must not reach
    // the latter by accident (a spread defeats excess-property checking).
    runs: summary.runs,
    failures: summary.failures,
    costUsd: summary.costUsd,
    effectiveCostUsd: summary.effectiveCostUsd,
    unpricedRuns: summary.unpricedRuns,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheCreationTokens: summary.cacheCreationTokens,
    averages: {
      runsPerDay: perDay(summary.runs),
      costUsdPerDay,
      costUsdPerMonth: perMonth(costUsdPerDay),
      effectiveCostUsdPerDay,
      effectiveCostUsdPerMonth: perMonth(effectiveCostUsdPerDay),
    },
  };
}

/** The database's logical size: every page it holds, the WAL sidecar aside. */
function databaseSizeBytes(db: Database): number {
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  return pages * pageSize;
}
