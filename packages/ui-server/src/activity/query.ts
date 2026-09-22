/**
 * The agent-facing read over the activity record — the same data the UI
 * reads, shaped for model consumption and served through the backend
 * bridge's `queryActivity` seam (the MCP tool calls it).
 *
 * Read-only by construction: nothing here writes. Free-text fields that
 * originated outside the primary agent's own context (failure reasons /
 * stderr tails, subagent transcript excerpts) are DATA, not instructions —
 * the tool layer labels them as such before they reach a model.
 */
import type { Database } from "bun:sqlite";
import type { ActivityQuery, ActivityQueryResult } from "@schlessera/brain-ui-sdk/server";

import { latestActivityDigest } from "./digest.js";
import type { ActivityNotifier } from "./notify.js";
import { rowToRunRollup, summarizeRollups, type ActivityStore, type SpanRow } from "./store.js";

export function runActivityQuery(
  db: Database,
  store: ActivityStore,
  query: ActivityQuery,
  notifier?: ActivityNotifier
): ActivityQueryResult {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const hoursBack = Math.min(Math.max(query.hoursBack ?? 24, 1), 24 * 90);
  const since = Date.now() - hoursBack * 60 * 60 * 1000;

  switch (query.scope) {
    case "running": {
      return {
        running: store.openRootSpans().map(liveSummary),
      };
    }

    case "recent": {
      const rows = (
        db
          .query(
            "SELECT * FROM activity_run_rollups WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?"
          )
          .all(since, limit) as any[]
      ).map(rowToRunRollup);
      return {
        windowHours: hoursBack,
        running: store.openRootSpans().map(liveSummary),
        finished: rows.map((r) => ({
          runId: r.runId,
          origin: r.origin,
          name: r.name,
          jobName: r.jobName,
          sessionId: r.sessionId,
          principalId: r.principalId,
          principalLabel: r.principalLabel,
          principalKind: r.principalKind,
          startedAt: iso(r.startedAt),
          outcome: r.outcome,
          durationMs: r.durationMs,
          costUsd: r.costUsd,
          // Explicit nulls, never omitted: the model must be able to tell
          // "unknown" (null) from "genuinely free" ($0) — AE3.
          effectiveCostUsd: r.effectiveCostUsd,
          billingMode: r.billingMode,
          pricingEstimate: r.pricingEstimate,
          failureReason: r.failureReason,
        })),
      };
    }

    case "run": {
      if (!query.runId) return { error: "scope 'run' needs runId" };
      const snapshot = store.snapshotRun(query.runId);
      if (snapshot) {
        // The cost facts live on the rollup, not the spans — attach them here
        // the same way the REST detail route does, so the agent sees the
        // frozen triple for a finished run without waiting for detail
        // pruning. Explicit nulls (AE3): a still-running run has no rollup
        // yet, and unknown must never read as $0.
        const rollupRow = db
          .query("SELECT * FROM activity_run_rollups WHERE run_id = ?")
          .get(query.runId) as any;
        const liveRollup = rollupRow ? rowToRunRollup(rollupRow) : null;
        return {
          runId: query.runId,
          costUsd: liveRollup?.costUsd ?? null,
          effectiveCostUsd: liveRollup?.effectiveCostUsd ?? null,
          billingMode: liveRollup?.billingMode ?? null,
          pricingEstimate: liveRollup?.pricingEstimate ?? null,
          failureReason: liveRollup?.failureReason ?? null,
          spans: snapshot.spans.map((s) => ({
            spanId: s.spanId,
            parent: s.parentSpanId,
            name: s.name,
            kind: s.kind,
            principalId: s.principalId,
            startedAt: iso(s.startedAt),
            endedAt: s.endedAt ? iso(s.endedAt) : null,
            outcome: s.outcome,
            reason: s.outcomeReason,
            costUsd: s.usage.costUsd,
            tokens:
              s.usage.inputTokens !== undefined || s.usage.outputTokens !== undefined
                ? { in: s.usage.inputTokens, out: s.usage.outputTokens }
                : undefined,
          })),
        };
      }
      const row = db
        .query("SELECT * FROM activity_run_rollups WHERE run_id = ?")
        .get(query.runId) as any;
      if (!row) return { error: `unknown run ${query.runId}` };
      const rollup = rowToRunRollup(row);
      return {
        runId: query.runId,
        detailPruned: true,
        rollup: {
          name: rollup.name,
          jobName: rollup.jobName,
          principalId: rollup.principalId,
          principalLabel: rollup.principalLabel,
          principalKind: rollup.principalKind,
          outcome: rollup.outcome,
          startedAt: iso(rollup.startedAt),
          durationMs: rollup.durationMs,
          costUsd: rollup.costUsd,
          effectiveCostUsd: rollup.effectiveCostUsd,
          billingMode: rollup.billingMode,
          pricingEstimate: rollup.pricingEstimate,
          failureReason: rollup.failureReason,
        },
      };
    }

    case "rollups": {
      const rows = (
        db
          .query("SELECT * FROM activity_run_rollups WHERE started_at >= ?")
          .all(since) as any[]
      ).map(rowToRunRollup);
      const digest = latestActivityDigest(db);
      const summary = summarizeRollups(rows);
      return {
        windowHours: hoursBack,
        runs: summary.runs,
        failures: summary.failures,
        // Both sums are sum-of-KNOWNS; the runs excluded from the effective
        // sum ride along as unpricedRuns so unknown never reads as $0 (AE3).
        costUsd: round(summary.costUsd),
        effectiveCostUsd: round(summary.effectiveCostUsd),
        unpricedRuns: summary.unpricedRuns,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        ...(digest ? { lastDigestAt: iso(digest.generatedAt) } : {}),
      };
    }

    case "inbox": {
      // The unacknowledged notification inbox — the same list the UI shows.
      if (!notifier) return { error: "inbox unavailable" };
      return {
        intents: notifier.inbox(limit).map((i) => ({
          kind: i.kind,
          title: i.title,
          status: i.status,
          createdAt: iso(i.createdAt),
          runId: i.runId,
        })),
      };
    }

    default:
      return { error: `unknown scope` };
  }
}

function liveSummary(span: SpanRow) {
  return {
    runId: span.runId,
    origin: span.origin,
    name: span.name,
    jobName: span.jobName,
    sessionId: span.sessionId,
    principalId: span.principalId,
    startedAt: iso(span.startedAt),
    elapsedMs: Date.now() - span.startedAt,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
