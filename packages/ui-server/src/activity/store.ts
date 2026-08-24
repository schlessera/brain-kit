/**
 * The activity store: the canonical record of agent activity (migration 007).
 *
 * Every unit of agent work — a turn, a tool call, a subagent run, a cron run —
 * is a span row forming a tree per run. Spans are written AT START (a
 * non-terminal row exists while the work runs — that is what makes
 * glance-checks, stuck-run detection, and "what is running?" queries
 * possible) and updated to a write-once terminal outcome.
 *
 * Ordering has two primitives, both minted here inside the write transaction:
 *
 * - `seq` is per-run monotonic and totally orders every delta-visible write
 *   within a run. A snapshot carries the run's high-water seq; a client
 *   discards deltas at or below it. Deltas are derived from committed rows —
 *   persist-then-emit — so the stream can never show what the store does not
 *   hold.
 * - `change_id` (AUTOINCREMENT rowid of activity_changes) is the GLOBAL
 *   cursor. It exists because per-run seq cannot discover a run the poller
 *   has never seen: a foreign writer's brand-new root span is visible only
 *   as "a change with a higher change_id than my cursor".
 *
 * Every write runs under an IMMEDIATE transaction: two processes write this
 * database (server + cron wrapper), and a deferred transaction losing the
 * upgrade race throws SQLITE_BUSY instead of waiting. `createUiDb` sets
 * `busy_timeout` so immediate transactions queue rather than throw.
 *
 * Nothing in here may ever fail the work being observed: callers that
 * instrument live turns wrap calls in try/catch and drop on error
 * (observability must not break the observed) — but the STORE itself throws
 * on programmer error, because a silent half-written record is worse than a
 * loud one.
 */
import type { Database } from "bun:sqlite";

export const SPAN_OUTCOMES = [
  "success",
  "error",
  "timeout",
  "cancelled",
  "denied",
  "interrupted",
] as const;
export type SpanOutcome = (typeof SPAN_OUTCOMES)[number];

export type SpanKind = "turn" | "tool" | "subagent" | "cron";
export type SpanOrigin = "session" | "cron";

/** Token usage as spans carry it — OTel GenAI attribute semantics. */
export interface SpanUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface SpanRow {
  spanId: string;
  runId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  origin: SpanOrigin;
  sessionId: string | null;
  jobName: string | null;
  attrs: Record<string, unknown>;
  startedAt: number;
  waitUntil: number | null;
  endedAt: number | null;
  outcome: SpanOutcome | null;
  outcomeReason: string | null;
  usage: SpanUsage;
  writer: string;
  lastHeartbeatAt: number | null;
}

export interface SpanEventRow {
  spanId: string;
  eventIndex: number;
  ts: number;
  eventType: string;
  payload: unknown;
  truncated: boolean;
}

/** One committed write, as the delta stream sees it. */
export type ActivityChange =
  | { changeId: number; runId: string; seq: number; kind: "span"; span: SpanRow }
  | { changeId: number; runId: string; seq: number; kind: "event"; event: SpanEventRow };

export interface StartSpanInput {
  spanId: string;
  runId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  origin: SpanOrigin;
  sessionId?: string;
  jobName?: string;
  attrs?: Record<string, unknown>;
  startedAt?: number;
}

export interface EndSpanInput {
  outcome: SpanOutcome;
  reason?: string;
  endedAt?: number;
  usage?: SpanUsage;
  attrs?: Record<string, unknown>;
}

export interface RunSnapshot {
  runId: string;
  spans: SpanRow[];
  events: SpanEventRow[];
  /** Per-run high-water seq at the moment of the read, in the SAME
   *  transaction as the reads — the poller/subscriber baseline. */
  highWaterSeq: number;
  /** Global cursor at the same moment, for pinning a poller baseline. */
  changeCursor: number;
}

export interface PruneOptions {
  /** Spans of runs that ended before this are prunable (digest floor). */
  digestFloorMs: number;
  /** Runs older than this are pruned REGARDLESS of the digest floor. */
  hardCeilingMs: number;
  now?: number;
  /** Max runs pruned per call — pruning is batched so writers are not starved. */
  batch?: number;
}

/** A single event payload is capped so no delta can approach the WS frame cap. */
export const MAX_EVENT_PAYLOAD_BYTES = 16_384;
export const TRUNCATION_MARKER = "…[truncated]";

export interface ActivityStore {
  readonly writer: string;
  startSpan(input: StartSpanInput): SpanRow;
  /**
   * Terminal write. Write-once: returns false (and writes nothing) if the
   * span is already terminal or unknown. Merged-outcome precedence lives in
   * the CALLER (the host merges reporter enrichment before its single
   * terminal write); the store just enforces once-ness.
   */
  endSpan(spanId: string, input: EndSpanInput): boolean;
  /** Non-terminal field updates (usage enrichment, wait boundary, attrs). */
  patchSpan(
    spanId: string,
    patch: { attrs?: Record<string, unknown>; usage?: SpanUsage; waitUntil?: number }
  ): boolean;
  appendEvent(spanId: string, eventType: string, payload: unknown, ts?: number): SpanEventRow | null;
  /** External writers touch their root span so staleness is heartbeat-age based. */
  heartbeat(spanId: string, at?: number): void;
  /** Close every open span of a run as `outcome` (children first), reason on all. */
  cascadeClose(runId: string, outcome: SpanOutcome, reason: string): number;
  /** Boot sweep: close THIS writer's leftover open spans as interrupted. */
  sweepOwnOrphans(): number;
  /** Close open spans whose root heartbeat (or own writer liveness) went stale. */
  sweepStale(staleAfterMs: number, now?: number): number;
  /** Open root spans running longer than the threshold — the watchdog signal. */
  findStuck(thresholdMs: number, now?: number): SpanRow[];
  changesSince(changeCursor: number, limit?: number): ActivityChange[];
  latestChangeCursor(): number;
  snapshotRun(runId: string): RunSnapshot | null;
  getSpan(spanId: string): SpanRow | null;
  openRootSpans(): SpanRow[];
  /** Upsert the run's rollup row from current span state (call on terminal). */
  rollupRun(runId: string): void;
  prune(options: PruneOptions): { runsPruned: number; spansDeleted: number };
}

export interface CreateActivityStoreOptions {
  /** Process identity stamped on every span this store writes. */
  writer?: string;
}

export function createActivityStore(
  db: Database,
  options: CreateActivityStoreOptions = {}
): ActivityStore {
  const writer = options.writer ?? `pid:${process.pid}:${Date.now()}`;

  // bun:sqlite transactions: `.immediate` takes the write lock up front, so a
  // concurrent writer waits (busy_timeout) instead of failing mid-upgrade.
  const inWrite = <T>(fn: () => T): T => db.transaction(fn).immediate();

  function nextSeq(runId: string): number {
    const row = db
      .query("SELECT COALESCE(MAX(seq), 0) AS hi FROM activity_changes WHERE run_id = ?")
      .get(runId) as { hi: number };
    return row.hi + 1;
  }

  function logChange(runId: string, seq: number, spanId: string, eventIndex?: number) {
    db.prepare(
      "INSERT INTO activity_changes (run_id, seq, span_id, event_index) VALUES (?, ?, ?, ?)"
    ).run(runId, seq, spanId, eventIndex ?? null);
  }

  function rowToSpan(r: any): SpanRow {
    return {
      spanId: r.span_id,
      runId: r.run_id,
      parentSpanId: r.parent_span_id,
      name: r.name,
      kind: r.kind,
      origin: r.origin,
      sessionId: r.session_id,
      jobName: r.job_name,
      attrs: safeParse(r.attrs) ?? {},
      startedAt: r.started_at,
      waitUntil: r.wait_until,
      endedAt: r.ended_at,
      outcome: r.outcome,
      outcomeReason: r.outcome_reason,
      usage: {
        inputTokens: r.input_tokens ?? undefined,
        outputTokens: r.output_tokens ?? undefined,
        cacheReadTokens: r.cache_read_tokens ?? undefined,
        cacheCreationTokens: r.cache_creation_tokens ?? undefined,
        costUsd: r.cost_usd ?? undefined,
        model: r.model ?? undefined,
      },
      writer: r.writer,
      lastHeartbeatAt: r.last_heartbeat_at,
    };
  }

  function rowToEvent(r: any): SpanEventRow {
    const parsed = safeParse(r.payload) as { v?: unknown; truncated?: boolean } | undefined;
    return {
      spanId: r.span_id,
      eventIndex: r.event_index,
      ts: r.ts,
      eventType: r.event_type,
      payload: parsed?.v,
      truncated: parsed?.truncated === true,
    };
  }

  function getSpanRaw(spanId: string): SpanRow | null {
    const r = db.query("SELECT * FROM activity_spans WHERE span_id = ?").get(spanId);
    return r ? rowToSpan(r) : null;
  }

  function endSpanInTx(spanId: string, input: EndSpanInput): boolean {
    const existing = db
      .query("SELECT run_id, outcome, attrs FROM activity_spans WHERE span_id = ?")
      .get(spanId) as { run_id: string; outcome: string | null; attrs: string | null } | null;
    if (!existing || existing.outcome !== null) return false;

    const endedAt = input.endedAt ?? Date.now();
    const attrs = input.attrs
      ? JSON.stringify({ ...(safeParse(existing.attrs) ?? {}), ...input.attrs })
      : existing.attrs;
    const u = input.usage ?? {};
    db.prepare(
      `UPDATE activity_spans SET outcome = ?, outcome_reason = ?, ended_at = ?, attrs = ?,
         input_tokens = COALESCE(?, input_tokens),
         output_tokens = COALESCE(?, output_tokens),
         cache_read_tokens = COALESCE(?, cache_read_tokens),
         cache_creation_tokens = COALESCE(?, cache_creation_tokens),
         cost_usd = COALESCE(?, cost_usd),
         model = COALESCE(?, model)
       WHERE span_id = ?`
    ).run(
      input.outcome,
      input.reason ?? null,
      endedAt,
      attrs,
      u.inputTokens ?? null,
      u.outputTokens ?? null,
      u.cacheReadTokens ?? null,
      u.cacheCreationTokens ?? null,
      u.costUsd ?? null,
      u.model ?? null,
      spanId
    );
    logChange(existing.run_id, nextSeq(existing.run_id), spanId);
    return true;
  }

  function rollupRunInTx(runId: string) {
    const spans = db
      .query("SELECT * FROM activity_spans WHERE run_id = ? ORDER BY started_at")
      .all(runId)
      .map(rowToSpan);
    if (spans.length === 0) return;
    const root = spans.find((s) => s.parentSpanId === null) ?? spans[0]!;
    // Aggregation scope: ROOT spans only. Result-level accounting (the
    // SDK's modelUsage) already includes subagent consumption — summing the
    // tree would double-count every fan-out. Verified empirically (plan U3
    // smoke test).
    const failure =
      spans.find((s) => s.outcome === "error" || s.outcome === "timeout")?.outcomeReason ??
      (root.outcome === "interrupted" ? "interrupted" : null);
    db.prepare(
      `INSERT INTO activity_run_rollups
         (run_id, origin, name, session_id, job_name, started_at, ended_at, outcome,
          duration_ms, span_count, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cost_usd, failure_reason, detail_pruned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(run_id) DO UPDATE SET
         ended_at = excluded.ended_at, outcome = excluded.outcome,
         duration_ms = excluded.duration_ms, span_count = excluded.span_count,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         cost_usd = excluded.cost_usd, failure_reason = excluded.failure_reason`
    ).run(
      runId,
      root.origin,
      root.name,
      root.sessionId,
      root.jobName,
      root.startedAt,
      root.endedAt,
      root.outcome,
      root.endedAt !== null ? root.endedAt - root.startedAt : null,
      spans.length,
      root.usage.inputTokens ?? null,
      root.usage.outputTokens ?? null,
      root.usage.cacheReadTokens ?? null,
      root.usage.cacheCreationTokens ?? null,
      root.usage.costUsd ?? null,
      failure
    );
  }

  return {
    writer,

    startSpan(input) {
      return inWrite(() => {
        const startedAt = input.startedAt ?? Date.now();
        db.prepare(
          `INSERT INTO activity_spans
             (span_id, run_id, parent_span_id, name, kind, origin, session_id, job_name,
              attrs, started_at, writer, last_heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.spanId,
          input.runId,
          input.parentSpanId ?? null,
          input.name,
          input.kind,
          input.origin,
          input.sessionId ?? null,
          input.jobName ?? null,
          input.attrs ? JSON.stringify(input.attrs) : null,
          startedAt,
          writer,
          input.parentSpanId ? null : startedAt
        );
        logChange(input.runId, nextSeq(input.runId), input.spanId);
        return getSpanRaw(input.spanId)!;
      });
    },

    endSpan(spanId, input) {
      return inWrite(() => endSpanInTx(spanId, input));
    },

    patchSpan(spanId, patch) {
      return inWrite(() => {
        const existing = db
          .query("SELECT run_id, outcome, attrs FROM activity_spans WHERE span_id = ?")
          .get(spanId) as { run_id: string; outcome: string | null; attrs: string | null } | null;
        if (!existing || existing.outcome !== null) return false;
        const attrs = patch.attrs
          ? JSON.stringify({ ...(safeParse(existing.attrs) ?? {}), ...patch.attrs })
          : existing.attrs;
        const u = patch.usage ?? {};
        db.prepare(
          `UPDATE activity_spans SET attrs = ?, wait_until = COALESCE(?, wait_until),
             input_tokens = COALESCE(?, input_tokens),
             output_tokens = COALESCE(?, output_tokens),
             cache_read_tokens = COALESCE(?, cache_read_tokens),
             cache_creation_tokens = COALESCE(?, cache_creation_tokens),
             cost_usd = COALESCE(?, cost_usd),
             model = COALESCE(?, model)
           WHERE span_id = ?`
        ).run(
          attrs,
          patch.waitUntil ?? null,
          u.inputTokens ?? null,
          u.outputTokens ?? null,
          u.cacheReadTokens ?? null,
          u.cacheCreationTokens ?? null,
          u.costUsd ?? null,
          u.model ?? null,
          spanId
        );
        logChange(existing.run_id, nextSeq(existing.run_id), spanId);
        return true;
      });
    },

    appendEvent(spanId, eventType, payload, ts) {
      return inWrite(() => {
        const span = db
          .query("SELECT run_id FROM activity_spans WHERE span_id = ?")
          .get(spanId) as { run_id: string } | null;
        if (!span) return null;
        const next = db
          .query(
            "SELECT COALESCE(MAX(event_index), -1) + 1 AS idx FROM activity_events WHERE span_id = ?"
          )
          .get(spanId) as { idx: number };
        const stored = capPayload(payload);
        db.prepare(
          "INSERT INTO activity_events (span_id, event_index, ts, event_type, payload) VALUES (?, ?, ?, ?, ?)"
        ).run(spanId, next.idx, ts ?? Date.now(), eventType, JSON.stringify(stored));
        logChange(span.run_id, nextSeq(span.run_id), spanId, next.idx);
        const r = db
          .query("SELECT * FROM activity_events WHERE span_id = ? AND event_index = ?")
          .get(spanId, next.idx);
        return rowToEvent(r);
      });
    },

    heartbeat(spanId, at) {
      inWrite(() => {
        // Deliberately NOT change-logged: a heartbeat is liveness metadata,
        // not activity the client needs a delta for.
        db.prepare(
          "UPDATE activity_spans SET last_heartbeat_at = ? WHERE span_id = ? AND outcome IS NULL"
        ).run(at ?? Date.now(), spanId);
      });
    },

    cascadeClose(runId, outcome, reason) {
      return inWrite(() => {
        const open = db
          .query(
            "SELECT span_id FROM activity_spans WHERE run_id = ? AND outcome IS NULL ORDER BY started_at DESC"
          )
          .all(runId) as Array<{ span_id: string }>;
        let closed = 0;
        for (const { span_id } of open) {
          if (endSpanInTx(span_id, { outcome, reason })) closed++;
        }
        if (closed > 0) rollupRunInTx(runId);
        return closed;
      });
    },

    sweepOwnOrphans() {
      return inWrite(() => {
        // "Own" means this PROCESS IDENTITY's rows from a previous life. The
        // writer stamp includes the start time, so rows written by the
        // current instance never match a fresh store's sweep... but a boot
        // sweep runs before any spans are written, so sweeping by pid-prefix
        // alone would be wrong across pid reuse. Sweep every session-origin
        // open span instead: only THIS server writes session spans, and at
        // boot none of ours can legitimately be open.
        const open = db
          .query(
            "SELECT DISTINCT run_id FROM activity_spans WHERE outcome IS NULL AND origin = 'session'"
          )
          .all() as Array<{ run_id: string }>;
        let closed = 0;
        for (const { run_id } of open) {
          const rows = db
            .query(
              "SELECT span_id FROM activity_spans WHERE run_id = ? AND outcome IS NULL ORDER BY started_at DESC"
            )
            .all(run_id) as Array<{ span_id: string }>;
          for (const { span_id } of rows) {
            if (endSpanInTx(span_id, { outcome: "interrupted", reason: "server restarted" }))
              closed++;
          }
          rollupRunInTx(run_id);
        }
        return closed;
      });
    },

    sweepStale(staleAfterMs, now) {
      return inWrite(() => {
        const cutoff = (now ?? Date.now()) - staleAfterMs;
        // Staleness is judged on ROOT heartbeat age — never span age — so a
        // legitimately long, quiet run with a live writer is never killed.
        const staleRoots = db
          .query(
            `SELECT span_id, run_id FROM activity_spans
             WHERE outcome IS NULL AND parent_span_id IS NULL
               AND writer != ? AND COALESCE(last_heartbeat_at, started_at) < ?`
          )
          .all(writer, cutoff) as Array<{ span_id: string; run_id: string }>;
        let closed = 0;
        for (const { run_id } of staleRoots) {
          const rows = db
            .query(
              "SELECT span_id FROM activity_spans WHERE run_id = ? AND outcome IS NULL ORDER BY started_at DESC"
            )
            .all(run_id) as Array<{ span_id: string }>;
          for (const { span_id } of rows) {
            if (endSpanInTx(span_id, { outcome: "interrupted", reason: "writer went silent" }))
              closed++;
          }
          rollupRunInTx(run_id);
        }
        return closed;
      });
    },

    findStuck(thresholdMs, now) {
      const cutoff = (now ?? Date.now()) - thresholdMs;
      return (
        db
          .query(
            "SELECT * FROM activity_spans WHERE outcome IS NULL AND parent_span_id IS NULL AND started_at < ?"
          )
          .all(cutoff) as any[]
      ).map(rowToSpan);
    },

    changesSince(changeCursor, limit = 500) {
      const rows = db
        .query(
          "SELECT * FROM activity_changes WHERE change_id > ? ORDER BY change_id LIMIT ?"
        )
        .all(changeCursor, limit) as Array<{
        change_id: number;
        run_id: string;
        seq: number;
        span_id: string;
        event_index: number | null;
      }>;
      const changes: ActivityChange[] = [];
      for (const r of rows) {
        if (r.event_index === null) {
          const span = getSpanRaw(r.span_id);
          if (span)
            changes.push({ changeId: r.change_id, runId: r.run_id, seq: r.seq, kind: "span", span });
        } else {
          const ev = db
            .query("SELECT * FROM activity_events WHERE span_id = ? AND event_index = ?")
            .get(r.span_id, r.event_index);
          if (ev)
            changes.push({
              changeId: r.change_id,
              runId: r.run_id,
              seq: r.seq,
              kind: "event",
              event: rowToEvent(ev),
            });
        }
      }
      return changes;
    },

    latestChangeCursor() {
      const row = db
        .query("SELECT COALESCE(MAX(change_id), 0) AS hi FROM activity_changes")
        .get() as { hi: number };
      return row.hi;
    },

    snapshotRun(runId) {
      // A read transaction so spans, events, high-water seq, and the global
      // cursor are one consistent picture — the poller baseline is pinned to
      // exactly this moment (no gap between snapshot and first delta).
      return db.transaction(() => {
        const spans = (
          db
            .query("SELECT * FROM activity_spans WHERE run_id = ? ORDER BY started_at")
            .all(runId) as any[]
        ).map(rowToSpan);
        if (spans.length === 0) return null;
        const events = (
          db
            .query(
              `SELECT e.* FROM activity_events e
               JOIN activity_spans s ON s.span_id = e.span_id
               WHERE s.run_id = ? ORDER BY e.ts, e.event_index`
            )
            .all(runId) as any[]
        ).map(rowToEvent);
        const hi = db
          .query("SELECT COALESCE(MAX(seq), 0) AS hi FROM activity_changes WHERE run_id = ?")
          .get(runId) as { hi: number };
        const cursor = db
          .query("SELECT COALESCE(MAX(change_id), 0) AS hi FROM activity_changes")
          .get() as { hi: number };
        return { runId, spans, events, highWaterSeq: hi.hi, changeCursor: cursor.hi };
      })();
    },

    getSpan: getSpanRaw,

    openRootSpans() {
      return (
        db
          .query(
            "SELECT * FROM activity_spans WHERE outcome IS NULL AND parent_span_id IS NULL ORDER BY started_at DESC"
          )
          .all() as any[]
      ).map(rowToSpan);
    },

    rollupRun(runId) {
      inWrite(() => rollupRunInTx(runId));
    },

    prune(options) {
      const now = options.now ?? Date.now();
      const batch = options.batch ?? 50;
      // The digest floor gates pruning, but a dead digest job must not freeze
      // it forever: the hard ceiling prunes regardless (marking the rollup so
      // the coverage gap is visible).
      const floor = Math.max(options.digestFloorMs, 0);
      const ceiling = now - options.hardCeilingMs;
      return inWrite(() => {
        const candidates = db
          .query(
            `SELECT DISTINCT run_id, MAX(COALESCE(ended_at, 0)) AS ended
             FROM activity_spans
             GROUP BY run_id
             HAVING SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) = 0
                AND (ended < ? OR ended < ?)
             LIMIT ?`
          )
          .all(floor, ceiling, batch) as Array<{ run_id: string; ended: number }>;
        let spansDeleted = 0;
        for (const { run_id, ended } of candidates) {
          rollupRunInTx(run_id);
          db.prepare(
            "UPDATE activity_run_rollups SET detail_pruned = 1 WHERE run_id = ?"
          ).run(run_id);
          if (ended >= floor) {
            // Pruned by the hard ceiling alone — the digest never covered
            // this run; make the coverage gap visible on the rollup.
            db.prepare(
              "UPDATE activity_run_rollups SET failure_reason = COALESCE(failure_reason, 'digest coverage gap') WHERE run_id = ?"
            ).run(run_id);
          }
          db.prepare(
            `DELETE FROM activity_events WHERE span_id IN
               (SELECT span_id FROM activity_spans WHERE run_id = ?)`
          ).run(run_id);
          const res = db.prepare("DELETE FROM activity_spans WHERE run_id = ?").run(run_id);
          spansDeleted += res.changes;
          db.prepare("DELETE FROM activity_changes WHERE run_id = ?").run(run_id);
        }
        // The change log only serves live polling; rows this deep in the past
        // are unreachable by any live cursor. Keep runs with open spans.
        db.prepare(
          `DELETE FROM activity_changes WHERE change_id < (
             SELECT COALESCE(MAX(change_id), 0) FROM activity_changes
           ) - 100000 AND run_id NOT IN (
             SELECT DISTINCT run_id FROM activity_spans WHERE outcome IS NULL
           )`
        ).run();
        return { runsPruned: candidates.length, spansDeleted };
      });
    },
  };
}

function safeParse(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Cap a payload's serialized size, storing an explicit truncation marker. */
function capPayload(payload: unknown): { v: unknown; truncated?: boolean } {
  const json = JSON.stringify(payload ?? null);
  if (json.length <= MAX_EVENT_PAYLOAD_BYTES) return { v: payload ?? null };
  if (typeof payload === "string") {
    return { v: payload.slice(0, MAX_EVENT_PAYLOAD_BYTES) + TRUNCATION_MARKER, truncated: true };
  }
  return { v: json.slice(0, MAX_EVENT_PAYLOAD_BYTES) + TRUNCATION_MARKER, truncated: true };
}
