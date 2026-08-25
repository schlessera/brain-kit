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
import { isBillingMode, type BillingMode } from "@schlessera/brain-ui-sdk/protocol";

import {
  resolveAmbientBillingMode,
  resolveStandalonePricingConfig,
} from "../config/env.js";
import { createModelPricing, type PricingRates } from "../pricing/model-pricing.js";

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

/** One `activity_run_rollups` row, snake→camel. */
export interface RunRollupRow {
  runId: string;
  origin: SpanOrigin;
  name: string;
  sessionId: string | null;
  jobName: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: SpanOutcome | null;
  durationMs: number | null;
  spanCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  /**
   * What the run actually cost, frozen at first computation (migration 010):
   * 0 for subscription-billed work regardless of tokens, priced usage for
   * api-billed. NULL = unknown, 0 = genuinely free.
   */
  effectiveCostUsd: number | null;
  /** Billing classification behind `effectiveCostUsd`; NULL = unknown. */
  billingMode: BillingMode | null;
  /** True when the effective cost was computed from estimated rates. */
  pricingEstimate: boolean | null;
  failureReason: string | null;
  detailPruned: boolean;
}

/** The one snake→camel mapper for rollup rows — every reader shares it. */
export function rowToRunRollup(r: any): RunRollupRow {
  return {
    runId: r.run_id,
    origin: r.origin,
    name: r.name,
    sessionId: r.session_id,
    jobName: r.job_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    durationMs: r.duration_ms,
    spanCount: r.span_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costUsd: r.cost_usd,
    effectiveCostUsd: r.effective_cost_usd ?? null,
    billingMode: r.billing_mode ?? null,
    pricingEstimate: r.pricing_estimate == null ? null : r.pricing_estimate === 1,
    failureReason: r.failure_reason,
    detailPruned: r.detail_pruned === 1,
  };
}

/**
 * Sum-of-KNOWNS over effective costs: unknown (NULL) rows contribute nothing
 * to the sum and are counted instead, so no aggregate can pass an unknown off
 * as $0 (AE3). One definition for every reader that folds rollup rows.
 */
export function sumEffectiveCost(rows: Array<{ effectiveCostUsd: number | null }>): {
  effectiveCostUsd: number;
  unpricedRuns: number;
} {
  let effectiveCostUsd = 0;
  let unpricedRuns = 0;
  for (const row of rows) {
    if (row.effectiveCostUsd === null) unpricedRuns += 1;
    else effectiveCostUsd += row.effectiveCostUsd;
  }
  return { effectiveCostUsd, unpricedRuns };
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
  /** Spans of runs that ended before this are prunable (digest floor).
   *  Absolute epoch ms, not an offset. */
  digestFloorAt: number;
  /** Minimum age (ms since ended) a run must reach before the digest floor
   *  may prune its detail. 0 reproduces floor-only pruning. The hard
   *  ceiling ignores it. */
  detailRetentionMs: number;
  /** Runs older than this are pruned REGARDLESS of the digest floor. */
  hardCeilingMs: number;
  now?: number;
  /** Max runs pruned per call — pruning is batched so writers are not starved. */
  batch?: number;
}

/** A single event payload is capped so no delta can approach the WS frame cap. */
export const MAX_EVENT_PAYLOAD_BYTES = 16_384;

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
  /**
   * Append one event; null (nothing written) for an unknown span. `cap`
   * lowers the payload size cap for this call — the store's 16 KB invariant
   * is the ceiling regardless. A capped payload is clipped and flagged
   * `truncated`.
   */
  appendEvent(
    spanId: string,
    eventType: string,
    payload: unknown,
    ts?: number,
    cap?: number
  ): SpanEventRow | null;
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
  /**
   * Changes past the cursor whose span is a TERMINAL ROOT — the notifier's
   * detection query, filtered and joined SQL-side. One row per span (the
   * highest change_id it appears under).
   */
  terminalRootChangesSince(
    changeCursor: number,
    limit?: number
  ): Array<{ changeId: number; span: SpanRow }>;
  latestChangeCursor(): number;
  snapshotRun(runId: string): RunSnapshot | null;
  /** The run's high-water seq — what a full snapshot carries, without the reads. */
  runHighWaterSeq(runId: string): number;
  getSpan(spanId: string): SpanRow | null;
  openRootSpans(): SpanRow[];
  /** Upsert the run's rollup row from current span state (call on terminal). */
  rollupRun(runId: string): void;
  prune(options: PruneOptions): { runsPruned: number; spansDeleted: number };
}

/**
 * The pricing dependency rollups price through. `resolve` MUST be synchronous
 * — it is called inside the rollup write transaction, which never awaits.
 */
export interface RollupPricing {
  resolve(modelId: string): PricingRates | null;
}

export interface CreateActivityStoreOptions {
  /** Process identity stamped on every span this store writes. */
  writer?: string;
  /**
   * Pricing seam for rollup-time effective cost. Defaults to an env-derived
   * `createModelPricing` instance (the `$BRAIN_PATH` cache and the bundled
   * snapshot are both synchronous reads), constructed on first rollup — so
   * the cron wrapper's bare `createActivityStore(db)` prices identically to
   * the server with no wiring of its own. Tests inject a fake to stay
   * network- and disk-free (the default is also disabled under NODE_ENV=test,
   * mirroring the discovery flag's default).
   */
  pricing?: RollupPricing;
}

export function createActivityStore(
  db: Database,
  options: CreateActivityStoreOptions = {}
): ActivityStore {
  const writer = options.writer ?? `pid:${process.pid}:${Date.now()}`;

  // Lazy so a store that never rolls up (span-only paths, most tests)
  // touches neither the env nor the disk. The env reads live in
  // config/env.ts — the one chokepoint the env-access gate allows. Every
  // wrapper whose transaction can reach rollupRunInTx calls this BEFORE
  // entering `inWrite`, so the SQLite write lock never covers the two
  // synchronous JSON reads construction costs.
  let pricing: RollupPricing | undefined = options.pricing;
  const getPricing = (): RollupPricing =>
    (pricing ??= createModelPricing(resolveStandalonePricingConfig()));

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
    db.query(
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

  function runHighWaterSeqRaw(runId: string): number {
    const row = db
      .query("SELECT COALESCE(MAX(seq), 0) AS hi FROM activity_changes WHERE run_id = ?")
      .get(runId) as { hi: number };
    return row.hi;
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
    db.query(
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

  /** Close every open span of the run (children first) and roll it up. */
  function closeRunInTx(runId: string, outcome: SpanOutcome, reason: string): number {
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
      spans.find(
        (s) => (s.outcome === "error" || s.outcome === "timeout") && s.outcomeReason != null
      )?.outcomeReason ?? (root.outcome === "interrupted" ? "interrupted" : null);

    // Billing rides the root span when the recorder knew it at run start
    // (session runs, U3). A root without the attr — every cron root —
    // classifies from THIS process's env: for cron rollups the executing
    // process is the wrapper itself, i.e. exactly the credential set the
    // job's agent authenticated under, so classification and reality move
    // together.
    const attrBilling = root.attrs["brain.billing_mode"];
    const billingMode: BillingMode = isBillingMode(attrBilling)
      ? attrBilling
      : resolveAmbientBillingMode();

    // List-price math runs regardless of billing mode: it gap-fills a
    // missing backend cost_usd (pi without snapshots, cron) AND provides the
    // api-billed effective number. resolve() is synchronous by contract —
    // nothing here may await inside the write transaction.
    const usage = usageForPricing(root, spans);
    const priced =
      usage.kind === "usage" ? priceUsage(usage.byModel, getPricing()) : null;

    // Effective-cost semantics (NULL = unknown, 0 = genuinely free):
    // subscription → 0 regardless of tokens (AE1); api → the priced sum —
    // 0 when the run verifiably consumed nothing, NULL when usage was never
    // recorded (denied before inference) or any contributing model/rate is
    // missing. The estimate flag qualifies the effective number, so it is
    // NULL exactly when that is, and 0 for a subscription $0 (exact, not
    // estimated).
    const effectiveCostUsd =
      billingMode === "subscription" ? 0 : (priced?.costUsd ?? null);
    const pricingEstimate =
      billingMode === "subscription" ? 0 : priced ? (priced.estimate ? 1 : 0) : null;
    const costUsd = root.usage.costUsd ?? priced?.costUsd ?? null;

    db.query(
      `INSERT INTO activity_run_rollups
         (run_id, origin, name, session_id, job_name, started_at, ended_at, outcome,
          duration_ms, span_count, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cost_usd, effective_cost_usd, billing_mode,
          pricing_estimate, failure_reason, detail_pruned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(run_id) DO UPDATE SET
         ended_at = excluded.ended_at, outcome = excluded.outcome,
         duration_ms = excluded.duration_ms, span_count = excluded.span_count,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         cost_usd = COALESCE(excluded.cost_usd, activity_run_rollups.cost_usd),
         effective_cost_usd =
           COALESCE(activity_run_rollups.effective_cost_usd, excluded.effective_cost_usd),
         billing_mode = COALESCE(activity_run_rollups.billing_mode, excluded.billing_mode),
         pricing_estimate =
           COALESCE(activity_run_rollups.pricing_estimate, excluded.pricing_estimate),
         failure_reason = excluded.failure_reason`
      // cost_usd: a reported/computed value wins (backend stays authoritative),
      // but NULL never clobbers a previously gap-filled one. The effective
      // triple is FROZEN at first non-NULL computation (AE5): a re-rollup
      // after a pricing refresh must not silently reprice history — only a
      // still-NULL slot may be filled by a later computation.
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
      costUsd,
      effectiveCostUsd,
      billingMode,
      pricingEstimate,
      failure
    );
  }

  return {
    writer,

    startSpan(input) {
      return inWrite(() => {
        const startedAt = input.startedAt ?? Date.now();
        db.query(
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
        db.query(
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

    appendEvent(spanId, eventType, payload, ts, cap) {
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
        const stored = capPayload(payload, cap);
        const at = ts ?? Date.now();
        db.query(
          "INSERT INTO activity_events (span_id, event_index, ts, event_type, payload) VALUES (?, ?, ?, ?, ?)"
        ).run(spanId, next.idx, at, eventType, JSON.stringify(stored));
        logChange(span.run_id, nextSeq(span.run_id), spanId, next.idx);
        // Built from the values just written — no read-back needed.
        return {
          spanId,
          eventIndex: next.idx,
          ts: at,
          eventType,
          payload: stored.v,
          truncated: stored.truncated === true,
        };
      });
    },

    heartbeat(spanId, at) {
      inWrite(() => {
        // Deliberately NOT change-logged: a heartbeat is liveness metadata,
        // not activity the client needs a delta for.
        db.query(
          "UPDATE activity_spans SET last_heartbeat_at = ? WHERE span_id = ? AND outcome IS NULL"
        ).run(at ?? Date.now(), spanId);
      });
    },

    cascadeClose(runId, outcome, reason) {
      getPricing(); // construct outside the write lock; rollup reuses it
      return inWrite(() => closeRunInTx(runId, outcome, reason));
    },

    sweepOwnOrphans() {
      // "Own" means this PROCESS IDENTITY's rows from a previous life. The
      // writer stamp includes the start time, so rows written by the
      // current instance never match a fresh store's sweep... but a boot
      // sweep runs before any spans are written, so sweeping by pid-prefix
      // alone would be wrong across pid reuse. Sweep every session-origin
      // open span instead: only THIS server writes session spans, and at
      // boot none of ours can legitimately be open.
      //
      // Candidates are read OUTSIDE the write transaction — the common case
      // finds nothing and must not take the exclusive lock for it. The close
      // loop re-checks open-ness inside the transaction (endSpanInTx is
      // write-once), so a race just skips.
      const open = db
        .query(
          "SELECT DISTINCT run_id FROM activity_spans WHERE outcome IS NULL AND origin = 'session'"
        )
        .all() as Array<{ run_id: string }>;
      if (open.length === 0) return 0;
      getPricing(); // construct outside the write lock; rollup reuses it
      return inWrite(() => {
        let closed = 0;
        for (const { run_id } of open) {
          closed += closeRunInTx(run_id, "interrupted", "server restarted");
        }
        return closed;
      });
    },

    sweepStale(staleAfterMs, now) {
      const cutoff = (now ?? Date.now()) - staleAfterMs;
      // Staleness is judged on ROOT heartbeat age — never span age — so a
      // legitimately long, quiet run with a live writer is never killed.
      // Candidate read outside the write transaction, same as sweepOwnOrphans.
      const staleRoots = db
        .query(
          `SELECT span_id, run_id FROM activity_spans
           WHERE outcome IS NULL AND parent_span_id IS NULL
             AND writer != ? AND COALESCE(last_heartbeat_at, started_at) < ?`
        )
        .all(writer, cutoff) as Array<{ span_id: string; run_id: string }>;
      if (staleRoots.length === 0) return 0;
      getPricing(); // construct outside the write lock; rollup reuses it
      return inWrite(() => {
        let closed = 0;
        for (const { run_id } of staleRoots) {
          closed += closeRunInTx(run_id, "interrupted", "writer went silent");
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
      // Set-based: one join per change kind instead of a lookup per row. A
      // change whose span/event row was pruned drops out via the join, same
      // as the old per-row miss.
      const spanRows = db
        .query(
          `SELECT c.change_id, c.run_id, c.seq, s.*
           FROM activity_changes c
           JOIN activity_spans s ON s.span_id = c.span_id
           WHERE c.change_id > ? AND c.event_index IS NULL
           ORDER BY c.change_id LIMIT ?`
        )
        .all(changeCursor, limit) as any[];
      const eventRows = db
        .query(
          `SELECT c.change_id, c.run_id, c.seq, e.*
           FROM activity_changes c
           JOIN activity_events e
             ON e.span_id = c.span_id AND e.event_index = c.event_index
           WHERE c.change_id > ? AND c.event_index IS NOT NULL
           ORDER BY c.change_id LIMIT ?`
        )
        .all(changeCursor, limit) as any[];
      const changes: ActivityChange[] = [
        ...spanRows.map(
          (r): ActivityChange => ({
            changeId: r.change_id,
            runId: r.run_id,
            seq: r.seq,
            kind: "span",
            span: rowToSpan(r),
          })
        ),
        ...eventRows.map(
          (r): ActivityChange => ({
            changeId: r.change_id,
            runId: r.run_id,
            seq: r.seq,
            kind: "event",
            event: rowToEvent(r),
          })
        ),
      ];
      changes.sort((a, b) => a.changeId - b.changeId);
      return changes.length > limit ? changes.slice(0, limit) : changes;
    },

    terminalRootChangesSince(changeCursor, limit = 500) {
      const rows = db
        .query(
          `SELECT MAX(c.change_id) AS change_id, s.*
           FROM activity_changes c
           JOIN activity_spans s ON s.span_id = c.span_id
           WHERE c.change_id > ? AND c.event_index IS NULL
             AND s.parent_span_id IS NULL AND s.outcome IS NOT NULL
           GROUP BY s.span_id
           ORDER BY change_id LIMIT ?`
        )
        .all(changeCursor, limit) as any[];
      return rows.map((r) => ({ changeId: r.change_id, span: rowToSpan(r) }));
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
        const cursor = db
          .query("SELECT COALESCE(MAX(change_id), 0) AS hi FROM activity_changes")
          .get() as { hi: number };
        return {
          runId,
          spans,
          events,
          highWaterSeq: runHighWaterSeqRaw(runId),
          changeCursor: cursor.hi,
        };
      })();
    },

    runHighWaterSeq: runHighWaterSeqRaw,

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
      getPricing(); // construct outside the write lock; rollup reuses it
      inWrite(() => rollupRunInTx(runId));
    },

    prune(options) {
      const now = options.now ?? Date.now();
      const batch = options.batch ?? 50;
      // The digest floor gates pruning, but a dead digest job must not freeze
      // it forever: the hard ceiling prunes regardless (marking the rollup so
      // the coverage gap is visible). The floor alone is NOT enough: it meant
      // "safe to prune once summarized", but drill-in debugging is a second
      // reader of detail with a different clock — nightly cron runs end
      // before the morning digest, day sessions after, so floor-only pruning
      // took cron span trees within the hour while sessions kept theirs (it
      // looked cron-specific; it was clock skew). The retention cutoff ANDs
      // with the floor so covered runs still keep detail for a minimum window.
      const floor = Math.max(options.digestFloorAt, 0);
      const retentionCutoff = now - options.detailRetentionMs;
      const ceiling = now - options.hardCeilingMs;
      return inWrite(() => {
        // Candidates come from the rollups (they exist for every finished
        // run — that terminal write is what made the run prunable), guarded
        // against any run that still has an open span.
        const candidates = db
          .query(
            `SELECT run_id, ended_at AS ended FROM activity_run_rollups r
             WHERE detail_pruned = 0 AND ended_at IS NOT NULL
               AND ((ended_at < ? AND ended_at < ?) OR ended_at < ?)
               AND NOT EXISTS (
                 SELECT 1 FROM activity_spans s
                 WHERE s.run_id = r.run_id AND s.outcome IS NULL
               )
             LIMIT ?`
          )
          .all(floor, retentionCutoff, ceiling, batch) as Array<{ run_id: string; ended: number }>;
        let spansDeleted = 0;
        for (const { run_id, ended } of candidates) {
          db.query(
            "UPDATE activity_run_rollups SET detail_pruned = 1 WHERE run_id = ?"
          ).run(run_id);
          if (ended >= floor) {
            // Pruned by the hard ceiling alone — the digest never covered
            // this run; make the coverage gap visible on the rollup.
            db.query(
              "UPDATE activity_run_rollups SET failure_reason = COALESCE(failure_reason, 'digest coverage gap') WHERE run_id = ?"
            ).run(run_id);
          }
          db.query(
            `DELETE FROM activity_events WHERE span_id IN
               (SELECT span_id FROM activity_spans WHERE run_id = ?)`
          ).run(run_id);
          const res = db.query("DELETE FROM activity_spans WHERE run_id = ?").run(run_id);
          spansDeleted += res.changes;
          db.query("DELETE FROM activity_changes WHERE run_id = ?").run(run_id);
        }
        // The change log only serves live polling; rows this deep in the past
        // are unreachable by any live cursor. Keep runs with open spans.
        db.query(
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

/** Per-model token counts, as priced; absent fields count as zero consumed. */
interface PricedTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

type PricingUsage =
  /** Nothing recorded at all (denied before inference, pre-feature spans) → unknown. */
  | { kind: "none" }
  /** Usage exists but cannot be attributed to a model → whole run unknown. */
  | { kind: "unpriceable" }
  | { kind: "usage"; byModel: Record<string, PricedTokens> };

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The usage a run is priced from. Session runs carry the SDK's per-model
 * breakdown as a root attr (result-level accounting, subagents included —
 * the same root-only scope the token rollup uses). Cron runs have no root
 * aggregate: the wrapper's children carry the usage, summed per model here
 * — the sanctioned origin-scoped exception to root-only aggregation, safe
 * because sink children are not double-counted in their root.
 */
function usageForPricing(root: SpanRow, spans: SpanRow[]): PricingUsage {
  if (root.origin === "cron") {
    const byModel: Record<string, PricedTokens> = {};
    let sawUsage = false;
    for (const span of spans) {
      if (span.spanId === root.spanId) continue;
      const u = span.usage;
      if (
        u.inputTokens == null &&
        u.outputTokens == null &&
        u.cacheReadTokens == null &&
        u.cacheCreationTokens == null
      ) {
        continue; // no inference on this span (tool spans etc.) — not "unknown"
      }
      sawUsage = true;
      // Tokens without a model cannot be priced at any rate — guessing one
      // would silently misprice, so the whole run goes unknown.
      if (!u.model) return { kind: "unpriceable" };
      const agg = (byModel[u.model] ??= {});
      agg.inputTokens = (agg.inputTokens ?? 0) + (u.inputTokens ?? 0);
      agg.outputTokens = (agg.outputTokens ?? 0) + (u.outputTokens ?? 0);
      agg.cacheReadTokens = (agg.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
      agg.cacheCreationTokens = (agg.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0);
    }
    return sawUsage ? { kind: "usage", byModel } : { kind: "none" };
  }
  const perModel = root.attrs["gen_ai.usage.per_model"];
  if (typeof perModel !== "object" || perModel === null || Array.isArray(perModel)) {
    return { kind: "none" };
  }
  const byModel: Record<string, PricedTokens> = {};
  for (const [model, value] of Object.entries(perModel as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    byModel[model] = {
      inputTokens: tokenCount(v.inputTokens) ?? 0,
      outputTokens: tokenCount(v.outputTokens) ?? 0,
      cacheReadTokens: tokenCount(v.cacheReadTokens) ?? 0,
      cacheCreationTokens: tokenCount(v.cacheCreationTokens) ?? 0,
    };
  }
  return Object.keys(byModel).length > 0 ? { kind: "usage", byModel } : { kind: "none" };
}

/**
 * Price one run's per-model usage at list rates. Null = unknown: an
 * unresolvable model with consumed tokens, or a consumed token class with no
 * rate, poisons the WHOLE run — cache reads dominate Claude usage, so
 * partial pricing would systematically understate (the binding
 * missing-cache-rate decision). A model with zero consumption contributes
 * nothing and needs no rate. Variant/snapshot fallbacks are the pricing
 * service's job (`resolve()`); the store only propagates the estimate flag.
 */
function priceUsage(
  byModel: Record<string, PricedTokens>,
  pricing: RollupPricing
): { costUsd: number; estimate: boolean } | null {
  let costUsd = 0;
  let estimate = false;
  for (const [model, tokens] of Object.entries(byModel)) {
    const classes: Array<
      [count: number, rate: (r: PricingRates) => number | null]
    > = [
      [tokens.inputTokens ?? 0, (r) => r.input],
      [tokens.outputTokens ?? 0, (r) => r.output],
      [tokens.cacheReadTokens ?? 0, (r) => r.cacheRead],
      [tokens.cacheCreationTokens ?? 0, (r) => r.cacheWrite],
    ];
    if (!classes.some(([count]) => count > 0)) continue;
    const rates = pricing.resolve(model);
    if (!rates) return null;
    for (const [count, rateOf] of classes) {
      if (count <= 0) continue;
      const perToken = rateOf(rates);
      if (perToken === null) return null;
      costUsd += count * perToken;
    }
    if (rates.estimate) estimate = true;
  }
  return { costUsd, estimate };
}

function safeParse(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Cap a payload's serialized size; a clipped payload carries the `truncated`
 *  flag (which rides the wire), so no in-text marker is stored. */
function capPayload(payload: unknown, cap?: number): { v: unknown; truncated?: boolean } {
  const limit = Math.min(cap ?? MAX_EVENT_PAYLOAD_BYTES, MAX_EVENT_PAYLOAD_BYTES);
  const json = JSON.stringify(payload ?? null);
  if (json.length <= limit) return { v: payload ?? null };
  if (typeof payload === "string") {
    return { v: payload.slice(0, limit), truncated: true };
  }
  return { v: json.slice(0, limit), truncated: true };
}
