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
import { isFailureOutcome } from "@schlessera/brain-ui-sdk/protocol";

import { latestActivityDigest } from "./digest.js";
import { rowToRunRollup, type ActivityStore, type SpanRow } from "./store.js";

export function runActivityQuery(
  db: Database,
  store: ActivityStore,
  query: ActivityQuery
): ActivityQueryResult {
  const limit = Math.min(query.limit ?? 20, 100);
  const hoursBack = Math.min(query.hoursBack ?? 24, 24 * 90);
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
          startedAt: iso(r.startedAt),
          outcome: r.outcome,
          durationMs: r.durationMs,
          costUsd: r.costUsd,
          failureReason: r.failureReason,
        })),
      };
    }

    case "run": {
      if (!query.runId) return { error: "scope 'run' needs runId" };
      const snapshot = store.snapshotRun(query.runId);
      if (snapshot) {
        return {
          runId: query.runId,
          spans: snapshot.spans.map((s) => ({
            spanId: s.spanId,
            parent: s.parentSpanId,
            name: s.name,
            kind: s.kind,
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
          outcome: rollup.outcome,
          startedAt: iso(rollup.startedAt),
          durationMs: rollup.durationMs,
          costUsd: rollup.costUsd,
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
      return {
        windowHours: hoursBack,
        runs: rows.length,
        failures: rows.filter((r) => isFailureOutcome(r.outcome)).length,
        costUsd: round(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)),
        inputTokens: rows.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
        outputTokens: rows.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
        ...(digest ? { lastDigestAt: iso(digest.generatedAt) } : {}),
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
