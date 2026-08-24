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
import type { ActivityStore, SpanRow } from "./store.js";

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
      const rows = db
        .query(
          "SELECT * FROM activity_run_rollups WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?"
        )
        .all(since, limit) as any[];
      return {
        windowHours: hoursBack,
        running: store.openRootSpans().map(liveSummary),
        finished: rows.map((r) => ({
          runId: r.run_id,
          origin: r.origin,
          name: r.name,
          jobName: r.job_name,
          sessionId: r.session_id,
          startedAt: iso(r.started_at),
          outcome: r.outcome,
          durationMs: r.duration_ms,
          costUsd: r.cost_usd,
          failureReason: r.failure_reason,
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
      const rollup = db
        .query("SELECT * FROM activity_run_rollups WHERE run_id = ?")
        .get(query.runId) as any;
      if (!rollup) return { error: `unknown run ${query.runId}` };
      return {
        runId: query.runId,
        detailPruned: true,
        rollup: {
          name: rollup.name,
          jobName: rollup.job_name,
          outcome: rollup.outcome,
          startedAt: iso(rollup.started_at),
          durationMs: rollup.duration_ms,
          costUsd: rollup.cost_usd,
          failureReason: rollup.failure_reason,
        },
      };
    }

    case "rollups": {
      const rows = db
        .query("SELECT * FROM activity_run_rollups WHERE started_at >= ?")
        .all(since) as any[];
      const digest = latestActivityDigest(db);
      return {
        windowHours: hoursBack,
        runs: rows.length,
        failures: rows.filter(
          (r) => r.outcome === "error" || r.outcome === "timeout" || r.outcome === "interrupted"
        ).length,
        costUsd: round(rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0)),
        inputTokens: rows.reduce((a, r) => a + (r.input_tokens ?? 0), 0),
        outputTokens: rows.reduce((a, r) => a + (r.output_tokens ?? 0), 0),
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
