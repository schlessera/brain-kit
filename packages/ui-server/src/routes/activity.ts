import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import type { ActivityStore } from "../activity/store.js";
import { getSetting } from "../db/settings.js";

/**
 * The activity record's read API. Auth-guarded like every /api route (the
 * record leaks strictly more than /api/status, which is itself deliberately
 * behind the guard).
 *
 * Resolution rules (origin R26): a run id that ever existed resolves — to
 * the full span tree while detail is retained, to its rollup ("detail
 * pruned") afterwards; only never-existed ids 404. Cost/token aggregates
 * read per-run rollups, which carry ROOT-span accounting only.
 */
export function createActivityRoutes(deps: { db: Database; store: ActivityStore }): Hono {
  const { db, store } = deps;

  return new Hono()
    .get("/activity/runs", (c) => {
      try {
        const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
        const before = Number(c.req.query("before")) || Date.now() + 1;
        const origin = c.req.query("origin");
        const job = c.req.query("job");
        const session = c.req.query("session");
        const status = c.req.query("status");

        // Live first (open roots), then history from rollups. Rollups exist
        // for every finished run (terminal writes upsert them), so one table
        // serves the history list regardless of pruning state.
        const live = store
          .openRootSpans()
          .filter((s) => !origin || s.origin === origin)
          .filter((s) => !job || s.jobName === job)
          .filter((s) => !session || s.sessionId === session)
          .map((s) => ({
            runId: s.runId,
            origin: s.origin,
            name: s.name,
            sessionId: s.sessionId,
            jobName: s.jobName,
            startedAt: s.startedAt,
            endedAt: null,
            outcome: null,
            running: true,
            durationMs: null,
            costUsd: s.usage.costUsd ?? null,
            failureReason: null,
            detailPruned: false,
          }));

        const filters: string[] = ["started_at < ?"];
        const params: unknown[] = [before];
        if (origin) {
          filters.push("origin = ?");
          params.push(origin);
        }
        if (job) {
          filters.push("job_name = ?");
          params.push(job);
        }
        if (session) {
          filters.push("session_id = ?");
          params.push(session);
        }
        if (status) {
          filters.push("outcome = ?");
          params.push(status);
        }
        const liveRuns = new Set(live.map((r) => r.runId));
        const history = (
          db
            .query(
              `SELECT * FROM activity_run_rollups WHERE ${filters.join(" AND ")}
               ORDER BY started_at DESC LIMIT ?`
            )
            .all(...(params as never[]), limit) as any[]
        )
          .filter((r) => !liveRuns.has(r.run_id))
          .map((r) => ({
            runId: r.run_id,
            origin: r.origin,
            name: r.name,
            sessionId: r.session_id,
            jobName: r.job_name,
            startedAt: r.started_at,
            endedAt: r.ended_at,
            outcome: r.outcome,
            running: false,
            durationMs: r.duration_ms,
            costUsd: r.cost_usd,
            failureReason: r.failure_reason,
            detailPruned: r.detail_pruned === 1,
          }));

        return c.json({ live, history });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to list activity" },
          500
        );
      }
    })

    .get("/activity/runs/:runId", (c) => {
      const runId = c.req.param("runId");
      try {
        const snapshot = store.snapshotRun(runId);
        if (snapshot) {
          return c.json({
            runId,
            detailPruned: false,
            spans: snapshot.spans,
            events: snapshot.events,
            highWaterSeq: snapshot.highWaterSeq,
          });
        }
        const rollup = db
          .query("SELECT * FROM activity_run_rollups WHERE run_id = ?")
          .get(runId) as any;
        if (!rollup) return c.json({ error: "Unknown run" }, 404);
        return c.json({
          runId,
          detailPruned: true,
          rollup: {
            origin: rollup.origin,
            name: rollup.name,
            sessionId: rollup.session_id,
            jobName: rollup.job_name,
            startedAt: rollup.started_at,
            endedAt: rollup.ended_at,
            outcome: rollup.outcome,
            durationMs: rollup.duration_ms,
            spanCount: rollup.span_count,
            costUsd: rollup.cost_usd,
            failureReason: rollup.failure_reason,
          },
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to load run" },
          500
        );
      }
    })

    .get("/activity/rollups", (c) => {
      try {
        const days = Math.min(Number(c.req.query("days") ?? 7) || 7, 90);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        // The day boundary is the USER'S day, not UTC's — cron runs in UTC
        // but nobody reviews spend in it. Configurable server-side.
        const timeZone = getSetting<string>(db, "activity.timezone", "UTC");
        const dayOf = makeDayFormatter(timeZone);

        const rows = db
          .query(
            `SELECT run_id, origin, session_id, job_name, started_at, outcome,
                    duration_ms, cost_usd, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens
             FROM activity_run_rollups WHERE started_at >= ?`
          )
          .all(since) as any[];

        const byDay = new Map<string, Aggregate>();
        const byJob = new Map<string, Aggregate>();
        const bySession = new Map<string, Aggregate>();
        for (const r of rows) {
          add(byDay, dayOf(r.started_at), r);
          if (r.job_name) add(byJob, r.job_name, r);
          if (r.session_id) add(bySession, r.session_id, r);
        }

        return c.json({
          timeZone,
          days: [...byDay.entries()]
            .map(([key, a]) => ({ day: key, ...a }))
            .sort((a, b) => (a.day < b.day ? 1 : -1)),
          jobs: [...byJob.entries()].map(([key, a]) => ({ jobName: key, ...a })),
          sessions: [...bySession.entries()].map(([key, a]) => ({ sessionId: key, ...a })),
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to aggregate" },
          500
        );
      }
    });
}

interface Aggregate {
  runs: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
}

function add(map: Map<string, Aggregate>, key: string, r: any): void {
  const a =
    map.get(key) ??
    ({
      runs: 0,
      failures: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
    } satisfies Aggregate);
  a.runs += 1;
  if (r.outcome === "error" || r.outcome === "timeout" || r.outcome === "interrupted") {
    a.failures += 1;
  }
  a.costUsd += r.cost_usd ?? 0;
  a.inputTokens += r.input_tokens ?? 0;
  a.outputTokens += r.output_tokens ?? 0;
  a.cacheReadTokens += r.cache_read_tokens ?? 0;
  a.cacheCreationTokens += r.cache_creation_tokens ?? 0;
  a.durationMs += r.duration_ms ?? 0;
  map.set(key, a);
}

/** YYYY-MM-DD in the given zone; a bad zone degrades loudly to UTC once. */
function makeDayFormatter(timeZone: string): (ms: number) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", dateStyle: "short" });
  }
  return (ms) => fmt.format(new Date(ms));
}
