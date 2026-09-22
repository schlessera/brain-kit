import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { createUiDb } from "../src/db/client.js";
import {
  createActivityStore,
  MAX_EVENT_PAYLOAD_BYTES,
  rowToRunRollup,
  type ActivityStore,
  type RollupPricing,
} from "../src/activity/store.js";
import type { PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { PricingRates } from "../src/pricing/model-pricing.js";
import {
  getDetailRetentionDays,
  setDetailRetentionDays,
  setSetting,
} from "../src/db/settings.js";

function freshStore(writer?: string): { store: ActivityStore; db: ReturnType<typeof createUiDb> } {
  const db = createUiDb(":memory:");
  return { store: createActivityStore(db, { writer }), db };
}

function startTurn(store: ActivityStore, runId = "run-1", sessionId = "sess-1") {
  return store.startSpan({
    spanId: `${runId}-root`,
    runId,
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId,
  });
}

describe("activity store: spans and ordering", () => {
  test("span tree round-trips with per-run seq ordering", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "tool-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
      sessionId: "sess-1",
    });
    store.endSpan("tool-1", { outcome: "success" });
    store.endSpan("run-1-root", {
      outcome: "success",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01, model: "claude-fable-5" },
    });

    const snap = store.snapshotRun("run-1")!;
    expect(snap.spans.map((s) => s.spanId)).toEqual(["run-1-root", "tool-1"]);
    expect(snap.highWaterSeq).toBe(4); // two starts + two ends
    expect(snap.spans[1]!.parentSpanId).toBe("run-1-root");
    expect(snap.spans[0]!.usage.costUsd).toBe(0.01);

    const changes = store.changesSince(0);
    expect(changes.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(changes.map((c) => c.changeId)).size).toBe(4);
  });

  test("terminal state is write-once", () => {
    const { store } = freshStore();
    startTurn(store);
    expect(store.endSpan("run-1-root", { outcome: "error", reason: "boom" })).toBe(true);
    expect(store.endSpan("run-1-root", { outcome: "success" })).toBe(false);
    expect(store.getSpan("run-1-root")!.outcome).toBe("error");
    expect(store.patchSpan("run-1-root", { usage: { costUsd: 1 } })).toBe(false);
  });

  test("denied is a distinct outcome, wait boundary recorded", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "tool-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "execute_tool Bash",
      kind: "tool",
      origin: "session",
    });
    store.patchSpan("tool-1", { waitUntil: Date.now() });
    store.endSpan("tool-1", { outcome: "denied", reason: "user declined" });
    const span = store.getSpan("tool-1")!;
    expect(span.outcome).toBe("denied");
    expect(span.waitUntil).not.toBeNull();
  });

  test("cascade close cancels open children with reason", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "sub-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "invoke_agent subagent",
      kind: "subagent",
      origin: "session",
    });
    store.startSpan({
      spanId: "sub-1-tool",
      runId: "run-1",
      parentSpanId: "sub-1",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
    });
    const closed = store.cascadeClose("run-1", "cancelled", "turn aborted");
    expect(closed).toBe(3);
    for (const id of ["run-1-root", "sub-1", "sub-1-tool"]) {
      const s = store.getSpan(id)!;
      expect(s.outcome).toBe("cancelled");
      expect(s.outcomeReason).toBe("turn aborted");
    }
  });

  test("events are append-only, indexed, and capped with the truncated flag", () => {
    const { store } = freshStore();
    startTurn(store);
    store.appendEvent("run-1-root", "text", "hello");
    const big = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 100);
    const capped = store.appendEvent("run-1-root", "text", big)!;
    expect(capped.eventIndex).toBe(1);
    expect(capped.truncated).toBe(true);
    expect((capped.payload as string).length).toBeLessThan(big.length);
    expect(store.appendEvent("nonexistent", "text", "x")).toBeNull();

    const snap = store.snapshotRun("run-1")!;
    expect(snap.events).toHaveLength(2);
    expect(snap.events.map((e) => e.eventIndex)).toEqual([0, 1]);
  });

  test("snapshot pins high-water seq and global cursor consistently", () => {
    const { store } = freshStore();
    startTurn(store, "run-a");
    startTurn(store, "run-b");
    const snap = store.snapshotRun("run-a")!;
    expect(snap.highWaterSeq).toBe(1); // run-a has one write
    expect(snap.changeCursor).toBe(2); // globally two writes happened
    const later = store.changesSince(snap.changeCursor);
    expect(later).toHaveLength(0);
  });
});

describe("activity store: two writers", () => {
  test("interleaved writers on one file never collide on per-run seq", () => {
    const path = `/tmp/activity-two-writer-${process.pid}-${Date.now()}.db`;
    const dbA = createUiDb(path);
    const dbB = createUiDb(path);
    const server = createActivityStore(dbA, { writer: "server" });
    const cron = createActivityStore(dbB, { writer: "cron" });

    startTurn(server, "turn-run");
    cron.startSpan({
      spanId: "cron-root",
      runId: "cron-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    server.startSpan({
      spanId: "turn-tool",
      runId: "turn-run",
      parentSpanId: "turn-run-root",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
    });
    cron.endSpan("cron-root", { outcome: "success" });
    server.endSpan("turn-tool", { outcome: "success" });
    server.endSpan("turn-run-root", { outcome: "success" });

    // The server discovers the cron writer's run purely via the global cursor.
    const all = server.changesSince(0, 100);
    const cronChanges = all.filter((c) => c.runId === "cron-run");
    expect(cronChanges.map((c) => c.seq)).toEqual([1, 2]);
    const turnChanges = all.filter((c) => c.runId === "turn-run");
    expect(turnChanges.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    // Global cursor strictly increases across both writers.
    const ids = all.map((c) => c.changeId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    dbA.close();
    dbB.close();
  });
});

describe("activity store: rollups and retention", () => {
  test("rollup aggregates root-span usage only and survives pruning", () => {
    const { store, db } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "sub-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "invoke_agent subagent",
      kind: "subagent",
      origin: "session",
    });
    // Subagent usage present but must NOT be added to the rollup (the root's
    // result-level accounting already includes it).
    store.endSpan("sub-1", { outcome: "success", usage: { inputTokens: 999, costUsd: 5 } });
    store.endSpan("run-1-root", {
      outcome: "success",
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 1.02 },
    });
    store.rollupRun("run-1");

    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'run-1'")
      .get() as any;
    expect(rollup.cost_usd).toBe(1.02);
    expect(rollup.input_tokens).toBe(1200);
    expect(rollup.span_count).toBe(2);
    expect(rollup.detail_pruned).toBe(0);

    // `now` nudged forward: with a 0 window the cutoff is `now` itself, and
    // the run ended this same millisecond.
    const res = store.prune({
      digestFloorAt: Date.now() + 1000,
      detailRetentionMs: 0,
      hardCeilingMs: 0,
      now: Date.now() + 1000,
    });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("run-1")).toBeNull();
    const after = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'run-1'")
      .get() as any;
    expect(after.detail_pruned).toBe(1);
    expect(after.outcome).toBe("success");
  });

  test("prune never touches runs with open spans, hard ceiling marks coverage gap", () => {
    const { store, db } = freshStore();
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    store.startSpan({
      spanId: "old-root",
      runId: "old-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt: old,
    });
    store.endSpan("old-root", { outcome: "success", endedAt: old + 60_000 });
    // Prune candidates come from the rollups (every production terminal
    // path writes one); a bare endSpan in a test must roll up itself.
    store.rollupRun("old-run");
    startTurn(store, "live-run"); // stays open

    // Digest floor far in the past (digest broken) — only the ceiling prunes.
    const res = store.prune({ digestFloorAt: 0, detailRetentionMs: 0, hardCeilingMs: 90 * 24 * 60 * 60 * 1000 });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("live-run")).not.toBeNull();
    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'old-run'")
      .get() as any;
    expect(rollup.detail_pruned).toBe(1);
    expect(rollup.failure_reason).toBe("digest coverage gap");
  });
});

describe("activity store: detail retention window", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000; // fixed clock — prune() takes `now`
  const WEEK = 7 * DAY;
  const CEILING = 90 * DAY;

  function seedEnded(store: ActivityStore, runId: string, endedAt: number) {
    store.startSpan({
      spanId: `${runId}-root`,
      runId,
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt: endedAt - 60_000,
    });
    store.endSpan(`${runId}-root`, { outcome: "success", endedAt });
    store.rollupRun(runId);
  }

  test("a digest-covered run keeps its detail for the window, loses it after (AE6)", () => {
    const { store } = freshStore();
    seedEnded(store, "nightly", NOW - 5 * DAY);

    // Covered by the morning digest (floor is ahead of the run) — but only
    // five days old, inside the default window: retained.
    let res = store.prune({ digestFloorAt: NOW, detailRetentionMs: WEEK, hardCeilingMs: CEILING, now: NOW });
    expect(res.runsPruned).toBe(0);
    expect(store.snapshotRun("nightly")).not.toBeNull();

    // Day 8: past the window, still covered — pruned, only the rollup remains.
    res = store.prune({ digestFloorAt: NOW, detailRetentionMs: WEEK, hardCeilingMs: CEILING, now: NOW + 3 * DAY });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("nightly")).toBeNull();
  });

  test("covered and older than the window prunes in one pass", () => {
    const { store, db } = freshStore();
    seedEnded(store, "stale", NOW - 10 * DAY);
    const res = store.prune({ digestFloorAt: NOW, detailRetentionMs: WEEK, hardCeilingMs: CEILING, now: NOW });
    expect(res.runsPruned).toBe(1);
    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'stale'")
      .get() as any;
    expect(rollup.detail_pruned).toBe(1);
    // The digest covered it — no coverage-gap marking.
    expect(rollup.failure_reason).toBeNull();
  });

  test("older than the window but not digest-covered stays retained (floor still gates)", () => {
    const { store } = freshStore();
    seedEnded(store, "uncovered", NOW - 10 * DAY);
    // Digest never reached it: floor sits before the run's end.
    const res = store.prune({
      digestFloorAt: NOW - 20 * DAY,
      detailRetentionMs: WEEK,
      hardCeilingMs: CEILING,
      now: NOW,
    });
    expect(res.runsPruned).toBe(0);
    expect(store.snapshotRun("uncovered")).not.toBeNull();
  });

  test("a window larger than the hard ceiling does not block the ceiling", () => {
    const { store, db } = freshStore();
    seedEnded(store, "ancient", NOW - 100 * DAY);
    const res = store.prune({
      digestFloorAt: 0,
      detailRetentionMs: 365 * DAY,
      hardCeilingMs: CEILING,
      now: NOW,
    });
    expect(res.runsPruned).toBe(1);
    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'ancient'")
      .get() as any;
    expect(rollup.detail_pruned).toBe(1);
    // Ceiling-pruned without digest coverage — the gap stays visible.
    expect(rollup.failure_reason).toBe("digest coverage gap");
  });

  test("window 0 reproduces the old floor-only behavior", () => {
    const { store } = freshStore();
    seedEnded(store, "fresh", NOW - 60 * 60 * 1000);
    const res = store.prune({ digestFloorAt: NOW, detailRetentionMs: 0, hardCeilingMs: CEILING, now: NOW });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("fresh")).toBeNull();
  });

  test("the retention setting degrades garbage and negatives to the 7-day default", () => {
    const { db } = freshStore();
    // No row yet: default.
    expect(getDetailRetentionDays(db)).toBe(7);
    setDetailRetentionDays(db, 3);
    expect(getDetailRetentionDays(db)).toBe(3);
    // 0 is a valid choice (floor-only pruning), not garbage.
    setDetailRetentionDays(db, 0);
    expect(getDetailRetentionDays(db)).toBe(0);
    // Wrong type, negative, non-finite, corrupt JSON: all degrade to default.
    setSetting(db, "activity.retention.detailDays", "banana");
    expect(getDetailRetentionDays(db)).toBe(7);
    setSetting(db, "activity.retention.detailDays", -3);
    expect(getDetailRetentionDays(db)).toBe(7);
    setSetting(db, "activity.retention.detailDays", Number.NaN); // serializes as null
    expect(getDetailRetentionDays(db)).toBe(7);
    db.prepare(
      "UPDATE settings SET value = 'not json' WHERE key = 'activity.retention.detailDays'"
    ).run();
    expect(getDetailRetentionDays(db)).toBe(7);
  });
});

describe("activity store: effective cost (migration 010)", () => {
  /** Fake pricing table — never the real service; resolve stays sync + local. */
  function fakePricing(rates: Record<string, Partial<PricingRates>>): RollupPricing {
    return {
      resolve(modelId) {
        const r = rates[modelId];
        if (!r) return null;
        return {
          input: r.input ?? 0,
          output: r.output ?? 0,
          cacheRead: r.cacheRead !== undefined ? r.cacheRead : null,
          cacheWrite: r.cacheWrite !== undefined ? r.cacheWrite : null,
          estimate: r.estimate ?? false,
          source: r.source ?? "litellm",
        };
      },
    };
  }

  function pricedStore(rates: Record<string, Partial<PricingRates>>) {
    const db = createUiDb(":memory:");
    return { db, store: createActivityStore(db, { pricing: fakePricing(rates) }) };
  }

  /** Set/unset env vars for the duration of `fn`, restoring exactly. */
  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      saved[key] = process.env[key];
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  type PerModel = Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  >;

  /** Seed one finished session run and roll it up. */
  function sessionRun(
    store: ActivityStore,
    runId: string,
    opts: {
      billing?: "subscription" | "api";
      perModel?: PerModel;
      costUsd?: number;
      /** Verbatim `brain.pricing_route` attr — a bad value is a real case. */
      route?: unknown;
    } = {}
  ) {
    store.startSpan({
      spanId: `${runId}-root`,
      runId,
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId: "sess-1",
      attrs: {
        ...(opts.billing
          ? { "brain.billing_mode": opts.billing, "brain.profile_id": "default" }
          : {}),
        ...(opts.route !== undefined ? { "brain.pricing_route": opts.route } : {}),
      },
    });
    store.endSpan(`${runId}-root`, {
      outcome: "success",
      ...(opts.costUsd !== undefined ? { usage: { costUsd: opts.costUsd } } : {}),
      ...(opts.perModel ? { attrs: { "gen_ai.usage.per_model": opts.perModel } } : {}),
    });
    store.rollupRun(runId);
  }

  function rollupOf(db: ReturnType<typeof createUiDb>, runId: string) {
    return db.query("SELECT * FROM activity_run_rollups WHERE run_id = ?").get(runId) as any;
  }

  test("the rollup table carries the three nullable columns (migration applies)", () => {
    const { db } = freshStore();
    const columns = (
      db.query("PRAGMA table_info(activity_run_rollups)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).filter((c) => ["effective_cost_usd", "billing_mode", "pricing_estimate"].includes(c.name));
    expect(columns.map((c) => c.name).sort()).toEqual([
      "billing_mode",
      "effective_cost_usd",
      "pricing_estimate",
    ]);
    expect(columns.every((c) => c.notnull === 0)).toBe(true);
  });

  test("subscription-billed cache-heavy run rolls up effective $0, list gap-filled (AE1)", () => {
    const { db, store } = pricedStore({
      "claude-sonnet-4-6": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
    });
    sessionRun(store, "run-1", {
      billing: "subscription",
      perModel: { "claude-sonnet-4-6": { inputTokens: 500, cacheReadTokens: 2_000_000 } },
    });
    const r = rollupOf(db, "run-1");
    // Effective is $0 — not NULL, not the cache-read price.
    expect(r.effective_cost_usd).toBe(0);
    expect(r.billing_mode).toBe("subscription");
    expect(r.pricing_estimate).toBe(0); // a subscription $0 is exact
    // The backend reported no cost, so list gap-fills from the same token math.
    expect(r.cost_usd).toBeCloseTo(500 * 3e-6 + 2_000_000 * 3e-7, 10);
  });

  test("api-billed run prices per-model usage; the resolver's estimate flag propagates (AE2)", () => {
    // The variant fallback itself lives in ModelPricing.resolve()
    // (model-pricing.test.ts); the fake models that contract — a variant id
    // resolves to base rates flagged estimate — and the store must propagate
    // the flag into the rollup.
    const { db, store } = pricedStore({
      "z-ai/glm-4.7": { input: 1e-6, output: 2e-6, source: "openrouter" },
      "z-ai/glm-4.7:nitro": { input: 1e-6, output: 2e-6, estimate: true, source: "openrouter" },
    });
    sessionRun(store, "run-nitro", {
      billing: "api",
      perModel: { "z-ai/glm-4.7:nitro": { inputTokens: 100_000, outputTokens: 5_000 } },
    });
    const nitro = rollupOf(db, "run-nitro");
    expect(nitro.effective_cost_usd).toBeCloseTo(0.11, 10);
    expect(nitro.billing_mode).toBe("api");
    expect(nitro.pricing_estimate).toBe(1);
    expect(nitro.cost_usd).toBeCloseTo(0.11, 10); // gap-filled list

    // The exact catalog id is NOT an estimate...
    sessionRun(store, "run-exact", {
      billing: "api",
      perModel: { "z-ai/glm-4.7": { inputTokens: 1_000 } },
    });
    expect(rollupOf(db, "run-exact").pricing_estimate).toBe(0);

    // ...but snapshot-sourced rates are.
    const snap = pricedStore({
      "claude-sonnet-4-6": { input: 3e-6, output: 15e-6, estimate: true, source: "snapshot" },
    });
    sessionRun(snap.store, "run-snap", {
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 1_000 } },
    });
    expect(rollupOf(snap.db, "run-snap").pricing_estimate).toBe(1);
  });

  test("a model unknown to pricing rolls up NULL, never $0 (AE3)", () => {
    const { db, store } = pricedStore({});
    sessionRun(store, "run-1", {
      billing: "api",
      perModel: { "mystery-model": { inputTokens: 10_000 } },
    });
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
    expect(r.billing_mode).toBe("api");
    expect(r.cost_usd).toBeNull();
    // The rollup row is otherwise complete.
    expect(r.outcome).toBe("success");
    expect(r.span_count).toBe(1);
    // rowToRunRollup maps the triple, NULLs staying null (not false/0).
    const mapped = rowToRunRollup(r);
    expect(mapped.effectiveCostUsd).toBeNull();
    expect(mapped.billingMode).toBe("api");
    expect(mapped.pricingEstimate).toBeNull();
  });

  test("a consumed token class with no rate poisons the whole run", () => {
    const rates = { "claude-sonnet-4-6": { input: 3e-6, output: 15e-6 } }; // no cache rates
    const { db, store } = pricedStore(rates);
    sessionRun(store, "run-cached", {
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100, cacheReadTokens: 50 } },
    });
    // Cache tokens consumed, cache rate unknown: pricing the gap at zero
    // would systematically understate — whole run unknown instead.
    expect(rollupOf(db, "run-cached").effective_cost_usd).toBeNull();

    // The same rate prices a run that consumed no cache.
    sessionRun(store, "run-plain", {
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100 } },
    });
    expect(rollupOf(db, "run-plain").effective_cost_usd).toBeCloseTo(100 * 3e-6, 12);
  });

  test("backend-reported cost stays authoritative; effective is the priced number", () => {
    const { db, store } = pricedStore({ m: { input: 1e-6, output: 1e-6 } });
    sessionRun(store, "run-1", {
      billing: "api",
      costUsd: 1.23,
      perModel: { m: { inputTokens: 1_000 } },
    });
    const r = rollupOf(db, "run-1");
    expect(r.cost_usd).toBe(1.23); // never overwritten by the computed list price
    expect(r.effective_cost_usd).toBeCloseTo(0.001, 10);
  });

  test("no usage rolls up NULL (denied before inference); zero tokens roll up $0 free", () => {
    const { db, store } = pricedStore({ m: { input: 1e-6, output: 1e-6 } });
    sessionRun(store, "run-denied", { billing: "api" }); // no per-model attr at all
    const denied = rollupOf(db, "run-denied");
    expect(denied.effective_cost_usd).toBeNull();
    expect(denied.pricing_estimate).toBeNull();

    sessionRun(store, "run-zero", {
      billing: "api",
      perModel: { m: { inputTokens: 0, outputTokens: 0 } },
    });
    const zero = rollupOf(db, "run-zero");
    expect(zero.effective_cost_usd).toBe(0);
    expect(zero.pricing_estimate).toBe(0);
  });

  test("the effective triple is frozen across re-rollups (AE5)", () => {
    const db = createUiDb(":memory:");
    const first = createActivityStore(db, { pricing: fakePricing({ m: { input: 1e-6 } }) });
    sessionRun(first, "run-1", { billing: "api", perModel: { m: { inputTokens: 1_000 } } });
    expect(rollupOf(db, "run-1").effective_cost_usd).toBeCloseTo(0.001, 10);

    // A sweep-style re-rollup after a price change (2x) must not reprice.
    const second = createActivityStore(db, { pricing: fakePricing({ m: { input: 2e-6 } }) });
    second.rollupRun("run-1");
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeCloseTo(0.001, 10);
    expect(r.billing_mode).toBe("api");
    expect(r.pricing_estimate).toBe(0);
  });

  test("re-rollup with broken pricing never erases previously computed values", () => {
    const db = createUiDb(":memory:");
    const first = createActivityStore(db, { pricing: fakePricing({ m: { input: 1e-6 } }) });
    sessionRun(first, "run-1", { billing: "api", perModel: { m: { inputTokens: 1_000 } } });
    expect(rollupOf(db, "run-1").cost_usd).toBeCloseTo(0.001, 10); // gap-filled

    // Pricing gone (disabled/cold): NULL must not clobber the stored values.
    const broken = createActivityStore(db, { pricing: fakePricing({}) });
    broken.rollupRun("run-1");
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeCloseTo(0.001, 10);
    expect(r.cost_usd).toBeCloseTo(0.001, 10);
    expect(r.pricing_estimate).toBe(0);
  });

  test("a NULL effective cost may be filled by a later rollup (freeze guards non-NULL only)", () => {
    const db = createUiDb(":memory:");
    const cold = createActivityStore(db, { pricing: fakePricing({}) });
    sessionRun(cold, "run-1", { billing: "api", perModel: { m: { inputTokens: 1_000 } } });
    expect(rollupOf(db, "run-1").effective_cost_usd).toBeNull();

    const warm = createActivityStore(db, { pricing: fakePricing({ m: { input: 1e-6 } }) });
    warm.rollupRun("run-1");
    expect(rollupOf(db, "run-1").effective_cost_usd).toBeCloseTo(0.001, 10);
  });

  // --- route-aware pricing (#57) --------------------------------------------
  //
  // The catalogs share ids at different rates, so the model id alone cannot
  // price a run. These assert the STORE's half of that: it hands the route
  // recorded on the root span to resolve() and uses what comes back. Which
  // rate each route resolves to is model-pricing.test.ts's job.

  /** A pricing double keyed by route, recording every route it was asked for. */
  function routedPricing(
    byRoute: Record<string, Record<string, Partial<PricingRates>>>,
    asked: Array<PricingRoute | undefined> = []
  ): RollupPricing & { asked: Array<PricingRoute | undefined> } {
    return {
      asked,
      resolve(modelId, route) {
        asked.push(route);
        const r = byRoute[route ?? "(none)"]?.[modelId];
        if (!r) return null;
        return {
          input: r.input ?? 0,
          output: r.output ?? 0,
          cacheRead: r.cacheRead !== undefined ? r.cacheRead : null,
          cacheWrite: r.cacheWrite !== undefined ? r.cacheWrite : null,
          estimate: r.estimate ?? false,
          source: r.source ?? "litellm",
        };
      },
    };
  }

  /** One id, three answers — the collision the issue is about. */
  const SHARED_ID_RATES = {
    openrouter: { shared: { input: 2e-6, source: "openrouter" as const } },
    direct: { shared: { input: 1e-6, source: "litellm" as const } },
    // What resolve() answers when no route was passed: OpenRouter still leads,
    // exactly as it did before routes existed.
    "(none)": { shared: { input: 2e-6, source: "openrouter" as const } },
  };

  test("a run is priced by the route it took, not by model id alone (AC1)", () => {
    const db = createUiDb(":memory:");
    const pricing = routedPricing(SHARED_ID_RATES);
    const store = createActivityStore(db, { pricing });

    sessionRun(store, "run-or", {
      billing: "api",
      route: "openrouter",
      perModel: { shared: { inputTokens: 1_000 } },
    });
    sessionRun(store, "run-direct", {
      billing: "api",
      route: "direct",
      perModel: { shared: { inputTokens: 1_000 } },
    });

    // Same id, same tokens, different endpoint → different money. Pricing the
    // direct run at the resale rate would have doubled it.
    expect(rollupOf(db, "run-or").effective_cost_usd).toBeCloseTo(0.002, 10);
    expect(rollupOf(db, "run-direct").effective_cost_usd).toBeCloseTo(0.001, 10);
    expect(pricing.asked).toEqual(["openrouter", "direct"]);
  });

  test("an unknown route degrades to id-alone pricing, never to unpriced (AC3)", () => {
    const db = createUiDb(":memory:");
    const pricing = routedPricing(SHARED_ID_RATES);
    const store = createActivityStore(db, { pricing });

    // No attr at all (every run recorded before this feature), and a root
    // carrying a value that is not a route (a forged or future attr) — both
    // must resolve, and to the SAME figure the pre-route code produced.
    sessionRun(store, "run-none", {
      billing: "api",
      perModel: { shared: { inputTokens: 1_000 } },
    });
    sessionRun(store, "run-junk", {
      billing: "api",
      route: "vertex-via-carrier-pigeon",
      perModel: { shared: { inputTokens: 1_000 } },
    });

    for (const runId of ["run-none", "run-junk"]) {
      const r = rollupOf(db, runId);
      expect(r.effective_cost_usd).toBeCloseTo(0.002, 10);
      expect(r.pricing_estimate).toBe(0);
    }
    // Not merely "some route" — the unrecognised value is dropped, so the
    // store asks for NO route rather than passing junk through to pricing.
    expect(pricing.asked).toEqual([undefined, undefined]);
  });

  test("a model the route cannot price stays unknown, never $0 (AC4)", () => {
    const db = createUiDb(":memory:");
    // The direct catalog has nothing for this id, and the store must not
    // silently fall back to the other route's rate to produce a number.
    const store = createActivityStore(db, {
      pricing: routedPricing({ openrouter: { shared: { input: 2e-6 } }, direct: {} }),
    });

    sessionRun(store, "run-1", {
      billing: "api",
      route: "direct",
      perModel: { shared: { inputTokens: 1_000 } },
    });

    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
    expect(r.billing_mode).toBe("api");
    // And it stays unknown on the way out, rather than rendering as zero.
    expect(rowToRunRollup(r).effectiveCostUsd).toBeNull();
  });

  test("route-aware pricing resolves inside the rollup without awaiting (AC2)", () => {
    const db = createUiDb(":memory:");
    // A pricing double that fails the test if anything awaits it: resolve()
    // is the ONLY entry point the rollup may use, and it must answer inline.
    let resolvedInline = false;
    const store = createActivityStore(db, {
      pricing: {
        resolve(modelId, route) {
          resolvedInline = true;
          expect(route).toBe("openrouter");
          return {
            input: 2e-6,
            output: 0,
            cacheRead: null,
            cacheWrite: null,
            estimate: false,
            source: "openrouter",
          };
        },
      },
    });

    // rollupRun is synchronous by contract. If route awareness ever put an
    // await in the write transaction, the row could not be readable on the
    // very next statement, with no microtask having run in between.
    sessionRun(store, "run-1", {
      billing: "api",
      route: "openrouter",
      perModel: { shared: { inputTokens: 1_000 } },
    });
    expect(resolvedInline).toBe(true);
    expect(rollupOf(db, "run-1").effective_cost_usd).toBeCloseTo(0.002, 10);
  });

  test("a gap-filled list cost is frozen across re-rollups, same as the effective triple (AE5)", () => {
    // pi/cron-shaped run: the backend reported no cost, so cost_usd was
    // gap-filled from priced usage. A sweep-style re-rollup under a CHANGED
    // table must not reprice it — first write wins, exactly like the triple.
    const db = createUiDb(":memory:");
    const first = createActivityStore(db, { pricing: fakePricing({ m: { input: 1e-6 } }) });
    sessionRun(first, "run-1", { billing: "api", perModel: { m: { inputTokens: 1_000 } } });
    expect(rollupOf(db, "run-1").cost_usd).toBeCloseTo(0.001, 10);

    const second = createActivityStore(db, { pricing: fakePricing({ m: { input: 2e-6 } }) });
    second.rollupRun("run-1");
    expect(rollupOf(db, "run-1").cost_usd).toBeCloseTo(0.001, 10);
  });

  test("the freeze holds through a cascadeClose rollup followed by a re-rollup", () => {
    // Recorder-style terminal path: an interrupted run's rollup is written by
    // cascadeClose, not rollupRun — the freeze must hold there identically.
    const db = createUiDb(":memory:");
    const first = createActivityStore(db, { pricing: fakePricing({ m: { input: 1e-6 } }) });
    first.startSpan({
      spanId: "run-1-root",
      runId: "run-1",
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId: "sess-1",
      attrs: { "brain.billing_mode": "api" },
    });
    first.patchSpan("run-1-root", {
      attrs: { "gen_ai.usage.per_model": { m: { inputTokens: 1_000 } } },
    });
    first.cascadeClose("run-1", "interrupted", "server restarted");
    expect(rollupOf(db, "run-1").effective_cost_usd).toBeCloseTo(0.001, 10);

    const second = createActivityStore(db, { pricing: fakePricing({ m: { input: 2e-6 } }) });
    second.rollupRun("run-1");
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeCloseTo(0.001, 10);
    expect(r.cost_usd).toBeCloseTo(0.001, 10);
    expect(r.billing_mode).toBe("api");
  });

  test("a NULL effective slot is never filled under a flipped classification", () => {
    // First rollup: api credentials, unpriceable child → effective NULL
    // frozen under billing "api".
    const { db, store } = pricedStore({});
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: "key" }, () => {
      cronRun(store, "cron-1", [{ model: "mystery", inputTokens: 500 }]);
    });
    let r = rollupOf(db, "cron-1");
    expect(r.billing_mode).toBe("api");
    expect(r.effective_cost_usd).toBeNull();

    // The credential set flips to subscription before a sweep-style
    // re-rollup: the $0 computed under "subscription" must NOT land on the
    // api-classified row (a cross-classified price), and the frozen
    // classification must not change either.
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: undefined }, () => {
      store.rollupRun("cron-1");
    });
    r = rollupOf(db, "cron-1");
    expect(r.billing_mode).toBe("api");
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
  });

  test("a non-finite priced sum rolls up NULL — Infinity can never freeze", () => {
    const { db, store } = pricedStore({ m: { input: Number.MAX_VALUE } });
    sessionRun(store, "run-1", {
      billing: "api",
      perModel: { m: { inputTokens: 1_000_000 } },
    });
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
    expect(r.cost_usd).toBeNull(); // the gap-fill is equally guarded
  });

  test("rows that predate migration 010 read back a NULL triple through rowToRunRollup", () => {
    // Stepwise upgrade against the REAL migration files: apply everything
    // before 010, insert a rollup row exactly as the pre-feature server
    // wrote it, then apply 010. Proves the ALTERs (with their CHECKs) accept
    // a populated table and that the pre-feature row surfaces the unknown
    // triple, never a guessed classification or $0.
    const migrationsDir = join(import.meta.dir, "../migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const db = new Database(":memory:");
    for (const file of files.filter((f) => f < "010")) {
      db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
    }
    db.query(
      `INSERT INTO activity_run_rollups
         (run_id, origin, name, job_name, started_at, ended_at, outcome,
          duration_ms, span_count, input_tokens, output_tokens, cost_usd, detail_pruned)
       VALUES ('pre', 'cron', 'cron sync', 'sync', 1, 2, 'success', 1, 1, 10, 5, 0.5, 0)`
    ).run();
    db.query(
      `INSERT INTO activity_spans
         (span_id, run_id, name, kind, origin, started_at, writer)
       VALUES ('pre-root', 'pre', 'invoke_agent', 'turn', 'session', 1, 'old-server')`
    ).run();
    const tenAndLater = files.filter((f) => !(f < "010"));
    expect(tenAndLater[0]).toBe("010_effective_cost.sql");
    for (const file of tenAndLater) {
      db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
    }

    const mapped = rowToRunRollup(
      db.query("SELECT * FROM activity_run_rollups WHERE run_id = 'pre'").get()
    );
    expect(mapped.effectiveCostUsd).toBeNull();
    expect(mapped.billingMode).toBeNull();
    expect(mapped.pricingEstimate).toBeNull();
    expect(mapped.costUsd).toBe(0.5);
    expect(mapped.principalId).toBeNull();
    expect(mapped.principalLabel).toBeNull();
    expect(mapped.principalKind).toBeNull();
    expect(createActivityStore(db).getSpan("pre-root")!.principalId).toBeNull();

    // The CHECKs reject wrong non-NULL values at the door...
    expect(() =>
      db.query("UPDATE activity_run_rollups SET billing_mode = 'free' WHERE run_id = 'pre'").run()
    ).toThrow();
    expect(() =>
      db.query("UPDATE activity_run_rollups SET pricing_estimate = 2 WHERE run_id = 'pre'").run()
    ).toThrow();
    db.close();

    // ...and a value that got written around them degrades to null on read.
    expect(rowToRunRollup({ run_id: "x", billing_mode: "free" }).billingMode).toBeNull();
  });

  /** Seed one finished cron run with per-child usage and roll it up. */
  function cronRun(
    store: ActivityStore,
    runId: string,
    children: Array<{ model?: string; inputTokens?: number; outputTokens?: number }>
  ) {
    store.startSpan({
      spanId: `${runId}-root`,
      runId,
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    children.forEach((child, i) => {
      const spanId = `${runId}-child-${i}`;
      store.startSpan({
        spanId,
        runId,
        parentSpanId: `${runId}-root`,
        name: "invoke_agent",
        kind: "turn",
        origin: "cron",
        jobName: "sync",
      });
      const { model, ...tokens } = child;
      store.endSpan(spanId, {
        outcome: "success",
        ...(Object.keys(child).length > 0
          ? { usage: { ...tokens, ...(model ? { model } : {}) } }
          : {}),
      });
    });
    store.endSpan(`${runId}-root`, { outcome: "success" });
    store.rollupRun(runId);
  }

  test("cron runs classify from the executing process env and price summed children", () => {
    const { db, store } = pricedStore({ m: { input: 1e-6, output: 2e-6 } });

    // Subscription credentials in THIS process (the wrapper's own env for
    // real cron rollups): free regardless of tokens.
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: undefined }, () => {
      cronRun(store, "cron-sub", [{ model: "m", inputTokens: 1_000 }]);
    });
    const sub = rollupOf(db, "cron-sub");
    expect(sub.billing_mode).toBe("subscription");
    expect(sub.effective_cost_usd).toBe(0);

    // API key wins over the OAuth token (the Agent SDK's own precedence):
    // children priced, grouped by model and summed.
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "key" }, () => {
      cronRun(store, "cron-api", [
        { model: "m", inputTokens: 1_000, outputTokens: 100 },
        { model: "m", inputTokens: 2_000 },
      ]);
    });
    const api = rollupOf(db, "cron-api");
    expect(api.billing_mode).toBe("api");
    expect(api.effective_cost_usd).toBeCloseTo(3_000 * 1e-6 + 100 * 2e-6, 12);
    expect(api.cost_usd).toBeCloseTo(3_000 * 1e-6 + 100 * 2e-6, 12); // gap-filled
  });

  test("a cron run with an unpriceable child rolls up NULL (whole-run unknown)", () => {
    const { db, store } = pricedStore({ m: { input: 1e-6, output: 2e-6 } });
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: "key" }, () => {
      // One priceable child, one on a model the table lacks.
      cronRun(store, "cron-mixed", [
        { model: "m", inputTokens: 1_000 },
        { model: "mystery", inputTokens: 500 },
      ]);
      // Tokens with no model at all are equally unpriceable.
      cronRun(store, "cron-modelless", [{ inputTokens: 500 }]);
      // No child usage anywhere: unknown, not free.
      cronRun(store, "cron-silent", [{}]);
    });
    for (const runId of ["cron-mixed", "cron-modelless", "cron-silent"]) {
      const r = rollupOf(db, runId);
      expect(r.effective_cost_usd).toBeNull();
      expect(r.pricing_estimate).toBeNull();
      expect(r.billing_mode).toBe("api");
    }
  });

  test("a root billing attr beats the process env", () => {
    const { db, store } = pricedStore({});
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: undefined }, () => {
      // Env says subscription; the recorder said api at run start — attr wins.
      sessionRun(store, "run-1", { billing: "api" });
    });
    expect(rollupOf(db, "run-1").billing_mode).toBe("api");
  });

  test("pre-feature-shaped runs (no billing attrs, no pricing hit) stay unknown", () => {
    // The default (non-injected) pricing seam is disabled under NODE_ENV=test,
    // so this also exercises the bare createActivityStore(db) path the cron
    // wrapper uses — without touching disk or network.
    const { db, store } = freshStore();
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: "key" }, () => {
      sessionRun(store, "run-1", {
        perModel: { "claude-sonnet-4-6": { inputTokens: 1_000 } },
      });
    });
    const r = rollupOf(db, "run-1");
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
    expect(r.cost_usd).toBeNull();
  });

  test("a session root without a billing attr stays UNKNOWN — never env-classified", () => {
    // The ambient fallback is cron-only: this process's credentials say
    // nothing about whichever custom backend ran a session turn, and a wrong
    // subscription-$0 would freeze forever where unknown stays honest.
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, {
      pricing: {
        resolve: () => ({
          input: 1e-6,
          output: 2e-6,
          cacheRead: null,
          cacheWrite: null,
          estimate: false,
          source: "litellm" as const,
        }),
      },
    });
    withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: undefined }, () => {
      sessionRun(store, "run-unclassified", {
        perModel: { "claude-sonnet-4-6": { inputTokens: 1_000 } },
      });
    });
    const r = rollupOf(db, "run-unclassified");
    expect(r.billing_mode).toBeNull();
    expect(r.effective_cost_usd).toBeNull();
    expect(r.pricing_estimate).toBeNull();
  });
});
