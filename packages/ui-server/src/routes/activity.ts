import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  isFailureOutcome,
  type ActivityAggregate,
  type ActivityRollups,
  type ActivityRunDetail,
  type ActivityRunSummary,
} from "@schlessera/brain-ui-sdk/protocol";

import { rowToRunRollup, type ActivityStore } from "../activity/store.js";
import { toWireEvent, toWireRollup, toWireSpan } from "../activity/stream.js";
import type { ActivityNotifier } from "../activity/notify.js";
import {
  dismissActivityDigest,
  digestDismissedAt,
  generateActivityDigest,
  latestActivityDigest,
} from "../activity/digest.js";
import { getSetting, setSetting } from "../db/settings.js";

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
export function createActivityRoutes(deps: {
  db: Database;
  store: ActivityStore;
  notifier?: ActivityNotifier;
}): Hono {
  const { db, store, notifier } = deps;

  return new Hono()
    .get("/activity/digest", (c) => {
      try {
        // An authenticated fetch IS the app opening — the marker the next
        // digest window's framing leans on.
        setSetting(db, "activity.lastVisitAt", Date.now());
        return c.json({
          digest: latestActivityDigest(db),
          dismissedAt: digestDismissedAt(db),
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to load digest" },
          500
        );
      }
    })

    .post("/activity/digest/dismiss", (c) => {
      try {
        dismissActivityDigest(db);
        return c.json({ ok: true });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to dismiss" },
          500
        );
      }
    })

    .post("/activity/digest/generate", (c) => {
      // Manual trigger (the cron job calls generateActivityDigest directly
      // through the script; this exists for dev and for a pull-to-refresh).
      try {
        return c.json({ digest: generateActivityDigest(db) });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to generate" },
          500
        );
      }
    })

    .get("/activity/inbox", (c) => {
      try {
        return c.json({ intents: notifier?.inbox() ?? [] });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to list inbox" },
          500
        );
      }
    })

    .post("/activity/inbox/ack-all", (c) => {
      try {
        return c.json({ acknowledged: notifier?.acknowledgeAll() ?? 0 });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to acknowledge" },
          500
        );
      }
    })

    .post("/activity/inbox/:id/ack", (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id < 1) return c.json({ error: "Bad intent id" }, 400);
      try {
        const ok = notifier?.acknowledge(id) ?? false;
        return ok ? c.json({ ok: true }) : c.json({ error: "Unknown intent" }, 404);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to acknowledge" },
          500
        );
      }
    })
    .get("/activity/runs", (c) => {
      try {
        const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
        const before = Number(c.req.query("before")) || Date.now() + 1;
        const origin = c.req.query("origin");
        const job = c.req.query("job");
        const session = c.req.query("session");
        const status = c.req.query("status");

        // Live first (open roots), then history from rollups. Rollups exist
        // for every finished run (terminal writes upsert them), so one table
        // serves the history list regardless of pruning state.
        const live: ActivityRunSummary[] = store
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
            // No rollup yet — effective cost is unknown until the run prices.
            effectiveCostUsd: null,
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
        if (live.length > 0) {
          filters.push(`run_id NOT IN (${live.map(() => "?").join(", ")})`);
          params.push(...live.map((r) => r.runId));
        }
        const history: ActivityRunSummary[] = (
          db
            .query(
              `SELECT * FROM activity_run_rollups WHERE ${filters.join(" AND ")}
               ORDER BY started_at DESC LIMIT ?`
            )
            .all(...(params as never[]), limit) as any[]
        )
          .map(rowToRunRollup)
          // The wire mapping (explicit-null vs omit) lives in toWireRollup;
          // a summary adds only its identity and liveness fields on top.
          .map((r) => ({
            ...toWireRollup(r),
            origin: r.origin,
            runId: r.runId,
            running: false,
            detailPruned: r.detailPruned,
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
        const row = db
          .query("SELECT * FROM activity_run_rollups WHERE run_id = ?")
          .get(runId) as any;
        if (snapshot) {
          // Tool payload events (up to 16 KB each) dominate a run's byte
          // size, and the history list opens details eagerly — so the REST
          // detail ships WITHOUT them unless the drill-in asks
          // (?include=payloads). The WS snapshot path is untouched: a live
          // subscription already committed to the full stream.
          const includePayloads = c.req.query("include") === "payloads";
          const events = includePayloads
            ? snapshot.events
            : snapshot.events.filter(
                (e) => e.eventType !== "tool_input" && e.eventType !== "tool_output"
              );
          // Through the SAME wire mappers the live stream uses: a raw
          // SpanRow serializes null fields where the wire contract omits
          // them, which broke the client's `outcome === undefined`
          // liveness test on REST-loaded runs. The rollup rides along when
          // it exists (finished runs) so the detail view can show cost facts
          // without waiting for detail pruning to force the rollup-only path.
          const detail: ActivityRunDetail = {
            runId,
            detailPruned: false,
            spans: snapshot.spans.map(toWireSpan),
            events: events.map(toWireEvent),
            highWaterSeq: snapshot.highWaterSeq,
            ...(row ? { rollup: toWireRollup(rowToRunRollup(row)) } : {}),
          };
          return c.json(detail);
        }
        if (!row) return c.json({ error: "Unknown run" }, 404);
        const r = rowToRunRollup(row);
        const detail: ActivityRunDetail = { runId, detailPruned: true, rollup: toWireRollup(r) };
        return c.json(detail);
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

        // Job/session aggregates group SQL-side; the per-day fold stays in
        // JS because only Intl knows the configured timezone's day boundary.
        const rows = db
          .query(
            `SELECT started_at, outcome, duration_ms, cost_usd, effective_cost_usd,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             FROM activity_run_rollups WHERE started_at >= ?`
          )
          .all(since) as any[];
        const byDay = new Map<string, ActivityAggregate>();
        for (const r of rows) {
          add(byDay, dayOf(r.started_at), r);
        }

        const rollups: ActivityRollups = {
          timeZone,
          days: [...byDay.entries()]
            .map(([key, a]) => ({ day: key, ...a }))
            .sort((a, b) => (a.day < b.day ? 1 : -1)),
          jobs: groupedAggregates(db, since, "job_name").map(({ key, ...a }) => ({
            jobName: key,
            ...a,
          })),
          sessions: groupedAggregates(db, since, "session_id").map(({ key, ...a }) => ({
            sessionId: key,
            ...a,
          })),
        };
        return c.json(rollups);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to aggregate" },
          500
        );
      }
    });
}

/**
 * SQL-side aggregation per group key. The failure predicate mirrors the
 * SDK's `isFailureOutcome` — it cannot be shared into SQL, so keep the two
 * in sync.
 */
function groupedAggregates(
  db: Database,
  since: number,
  column: "job_name" | "session_id"
): Array<ActivityAggregate & { key: string }> {
  return db
    .query(
      `SELECT ${column} AS key,
              COUNT(*) AS runs,
              SUM(CASE WHEN outcome IN ('error', 'timeout', 'interrupted') THEN 1 ELSE 0 END) AS failures,
              SUM(COALESCE(cost_usd, 0)) AS costUsd,
              SUM(COALESCE(effective_cost_usd, 0)) AS effectiveCostUsd,
              SUM(CASE WHEN effective_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedRuns,
              SUM(COALESCE(input_tokens, 0)) AS inputTokens,
              SUM(COALESCE(output_tokens, 0)) AS outputTokens,
              SUM(COALESCE(cache_read_tokens, 0)) AS cacheReadTokens,
              SUM(COALESCE(cache_creation_tokens, 0)) AS cacheCreationTokens,
              SUM(COALESCE(duration_ms, 0)) AS durationMs
       FROM activity_run_rollups
       WHERE started_at >= ? AND ${column} IS NOT NULL
       GROUP BY ${column}`
    )
    .all(since) as Array<ActivityAggregate & { key: string }>;
}

function add(map: Map<string, ActivityAggregate>, key: string, r: any): void {
  const a =
    map.get(key) ??
    ({
      runs: 0,
      failures: 0,
      costUsd: 0,
      effectiveCostUsd: 0,
      unpricedRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
    } satisfies ActivityAggregate);
  a.runs += 1;
  if (isFailureOutcome(r.outcome)) {
    a.failures += 1;
  }
  // Both cost sums are sum-of-KNOWNS (a missing value contributes nothing);
  // for effective cost the excluded rows are counted so no surface can pass
  // an unknown off as $0 (AE3).
  a.costUsd += r.cost_usd ?? 0;
  if (r.effective_cost_usd == null) {
    a.unpricedRuns = (a.unpricedRuns ?? 0) + 1;
  } else {
    a.effectiveCostUsd = (a.effectiveCostUsd ?? 0) + r.effective_cost_usd;
  }
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
