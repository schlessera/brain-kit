/**
 * The runtime stats channel (`GET /api/activity/stats`): lifetime figures
 * from `sessions`, windowed figures from `activity_run_rollups`, each
 * labelled with what it covers, and the AE3 rule that an unpriced run never
 * reads as $0 — not in a sum, and not in an average derived from one.
 */
import { describe, expect, test } from "bun:test";

import { computeRuntimeStats } from "../src/activity/stats";
import {
  createActivityStore,
  type ActivityStore,
  type RollupPricing,
} from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { createActivityRoutes } from "../src/routes/activity";
import { setDetailRetentionDays } from "../src/db/settings";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock — computeRuntimeStats takes `now`

/** Fake pricing — sync + local, mirroring the store test's seam. */
const rates: RollupPricing = {
  resolve: (modelId) =>
    modelId === "claude-sonnet-4-6"
      ? { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6, estimate: false, source: "litellm" }
      : null,
};

function fresh(pricing?: RollupPricing) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test", ...(pricing ? { pricing } : {}) });
  return { db, store };
}

function session(db: ReturnType<typeof createUiDb>, id: string, createdAt: number, lastActiveAt: number, cost: number, turns: number) {
  db.query(
    `INSERT INTO sessions (id, title, created_at, last_active_at, total_cost_usd, num_turns)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `Session ${id}`, createdAt, lastActiveAt, cost, turns);
}

function finishedRun(
  store: ActivityStore,
  runId: string,
  opts: {
    startedAt: number;
    endedAt: number;
    origin?: "session" | "cron";
    outcome?: "success" | "error";
    billing?: "subscription" | "api";
    perModel?: Record<string, { inputTokens: number; outputTokens?: number }>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
    };
  }
) {
  const origin = opts.origin ?? "session";
  store.startSpan({
    spanId: `${runId}:root`,
    runId,
    name: origin === "cron" ? "cron sync" : "invoke_agent",
    kind: origin === "cron" ? "cron" : "turn",
    origin,
    ...(origin === "cron" ? { jobName: "sync" } : { sessionId: "sess-1" }),
    ...(opts.billing ? { attrs: { "brain.billing_mode": opts.billing, "brain.profile_id": "default" } } : {}),
    startedAt: opts.startedAt,
  });
  store.endSpan(`${runId}:root`, {
    outcome: opts.outcome ?? "success",
    endedAt: opts.endedAt,
    ...(opts.usage ? { usage: opts.usage } : {}),
    ...(opts.perModel ? { attrs: { "gen_ai.usage.per_model": opts.perModel } } : {}),
  });
  store.rollupRun(runId);
}

/**
 * Two sessions over 40 days of lifetime, three runs inside a 30-day window
 * (one failed, one cron), one run 45 days back that a 30-day window must
 * not see.
 */
function seeded() {
  const { db, store } = fresh(rates);
  session(db, "s-old", NOW - 40 * DAY, NOW - 39 * DAY, 1.25, 5);
  session(db, "s-new", NOW - 2 * DAY, NOW - DAY, 0.75, 3);
  finishedRun(store, "run-a", {
    startedAt: NOW - 10 * DAY,
    endedAt: NOW - 10 * DAY + 60_000,
    billing: "api",
    perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } }, // $0.30
    usage: { inputTokens: 100_000, outputTokens: 2_000, costUsd: 0.5 },
  });
  finishedRun(store, "run-b", {
    startedAt: NOW - 3 * DAY,
    endedAt: NOW - 3 * DAY + 60_000,
    outcome: "error",
    billing: "subscription",
    perModel: { "claude-sonnet-4-6": { inputTokens: 1_000 } }, // effective $0
    usage: { inputTokens: 1_000, outputTokens: 100, costUsd: 0.1 },
  });
  // A cron run prices from its children (the origin-scoped exception), and
  // this one has none — subscription-billed, so its effective cost is $0
  // regardless, while its list-price cost still counts.
  finishedRun(store, "run-c", {
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 60_000,
    origin: "cron",
    billing: "subscription",
    usage: { inputTokens: 200_000, outputTokens: 4_000, costUsd: 1.0 },
  });
  finishedRun(store, "run-ancient", {
    startedAt: NOW - 45 * DAY,
    endedAt: NOW - 45 * DAY + 60_000,
    billing: "api",
    perModel: { "claude-sonnet-4-6": { inputTokens: 1_000_000 } },
    usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 3.0 },
  });
  return { db, store };
}

describe("runtime stats: lifetime from sessions, windowed from rollups", () => {
  test("lifetime session figures come from the sessions table and are labelled lifetime", () => {
    const { db } = seeded();
    const stats = computeRuntimeStats(db, { days: 30, now: NOW });

    expect(stats.generatedAt).toBe(NOW);
    expect(stats.lifetime.scope).toBe("lifetime");
    expect(stats.lifetime.sessions).toBe(2);
    expect(stats.lifetime.turns).toBe(8);
    expect(stats.lifetime.costUsd).toBeCloseTo(2.0, 10);
    expect(stats.lifetime.firstActivityAt).toBe(NOW - 40 * DAY);
    expect(stats.lifetime.lastActivityAt).toBe(NOW - DAY);
    expect(stats.lifetime.elapsedDays).toBeCloseTo(40, 10);
    expect(stats.lifetime.averages.costUsdPerSession).toBeCloseTo(1.0, 10);
    expect(stats.lifetime.averages.turnsPerSession).toBeCloseTo(4, 10);
    expect(stats.lifetime.averages.costUsdPerDay).toBeCloseTo(0.05, 10);
    expect(stats.lifetime.averages.costUsdPerMonth).toBeCloseTo(0.05 * (365.25 / 12), 10);
    db.close();
  });

  test("windowed figures cover exactly the requested window and say so", () => {
    const { db } = seeded();
    const stats = computeRuntimeStats(db, { days: 30, now: NOW });
    const w = stats.window;

    expect(w.scope).toBe("window");
    expect(w.days).toBe(30);
    expect(w.since).toBe(NOW - 30 * DAY);
    expect(w.until).toBe(NOW);
    // The record starts at the oldest rollup — outside this window, so the
    // window is fully covered.
    expect(w.recordedSince).toBe(NOW - 45 * DAY);
    expect(w.coveredDays).toBeCloseTo(30, 10);
    // run-ancient is excluded; the three in-window runs are summed.
    expect(w.runs).toBe(3);
    expect(w.failures).toBe(1);
    expect(w.inputTokens).toBe(301_000);
    expect(w.outputTokens).toBe(6_100);
    // The two fields this channel adds over the `rollups` scope: nothing in
    // the seed reports cache usage, so both read zero rather than undefined.
    expect(w.cacheReadTokens).toBe(0);
    expect(w.cacheCreationTokens).toBe(0);
    expect(w.costUsd).toBeCloseTo(1.6, 10);
    expect(w.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(w.unpricedRuns).toBe(0);
    expect(w.unpricedListCostRuns).toBe(0);
    expect(w.averages.runsPerDay).toBeCloseTo(0.1, 10);
    expect(w.averages.costUsdPerDay).toBeCloseTo(1.6 / 30, 10);
    expect(w.averages.effectiveCostUsdPerDay).toBeCloseTo(0.01, 10);
    expect(w.averages.effectiveCostUsdPerMonth).toBeCloseTo(0.01 * (365.25 / 12), 10);
    db.close();
  });

  test("cache tokens sum their own columns, and do not leak into the other token fields", () => {
    const { db, store } = fresh(rates);
    // Distinct magnitudes per column: a summed-from-the-wrong-column bug
    // cannot land on the right total by coincidence.
    finishedRun(store, "cached-a", {
      startedAt: NOW - 2 * DAY,
      endedAt: NOW - 2 * DAY + 1000,
      billing: "api",
      usage: {
        inputTokens: 1,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheCreationTokens: 4_000,
        costUsd: 0.1,
      },
    });
    finishedRun(store, "cached-b", {
      startedAt: NOW - DAY,
      endedAt: NOW - DAY + 1000,
      billing: "api",
      usage: {
        inputTokens: 2,
        outputTokens: 40,
        cacheReadTokens: 600,
        cacheCreationTokens: 8_000,
        costUsd: 0.1,
      },
    });
    const w = computeRuntimeStats(db, { days: 7, now: NOW }).window;
    expect(w.inputTokens).toBe(3);
    expect(w.outputTokens).toBe(60);
    expect(w.cacheReadTokens).toBe(900);
    expect(w.cacheCreationTokens).toBe(12_000);
    db.close();
  });

  test("a window reaching past the start of the record covers only the recorded days", () => {
    const { db } = seeded();
    const stats = computeRuntimeStats(db, { days: 90, now: NOW });
    expect(stats.window.runs).toBe(4);
    expect(stats.window.recordedSince).toBe(NOW - 45 * DAY);
    // Averages divide by the days the record can vouch for, not by 90.
    expect(stats.window.coveredDays).toBeCloseTo(45, 10);
    expect(stats.window.averages.runsPerDay).toBeCloseTo(4 / 45, 10);
    db.close();
  });

  test("the server database reports its size in bytes", () => {
    const { db } = seeded();
    const stats = computeRuntimeStats(db, { days: 30, now: NOW });
    const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
    expect(stats.database.sizeBytes).toBeGreaterThan(0);
    const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    expect(pages).toBeGreaterThan(1);
    expect(stats.database.sizeBytes).toBe(pages * pageSize);
    db.close();
  });
});

describe("runtime stats: retention labelling", () => {
  test("the window carries the detail-retention cutoff and whether it falls inside", () => {
    const { db } = seeded();
    setDetailRetentionDays(db, 7);

    const wide = computeRuntimeStats(db, { days: 30, now: NOW }).window;
    expect(wide.detailRetention.days).toBe(7);
    expect(wide.detailRetention.cutoffAt).toBe(NOW - 7 * DAY);
    expect(wide.detailRetention.insideWindow).toBe(true);

    const narrow = computeRuntimeStats(db, { days: 7, now: NOW }).window;
    expect(narrow.detailRetention.insideWindow).toBe(false);
    db.close();
  });

  test("pruning takes detail, not rollups: the sums hold and the pruned count says what is gone", () => {
    const { db, store } = seeded();
    setDetailRetentionDays(db, 7);
    const before = computeRuntimeStats(db, { days: 30, now: NOW }).window;
    expect(before.detailPrunedRuns).toBe(0);

    // The digest has covered everything; the 7-day retention window prunes
    // run-a (10 days back) and run-ancient, and keeps run-b and run-c.
    const res = store.prune({ digestFloorAt: NOW, detailRetentionMs: 7 * DAY, hardCeilingMs: 90 * DAY, now: NOW });
    expect(res.runsPruned).toBe(2);

    const after = computeRuntimeStats(db, { days: 30, now: NOW }).window;
    expect(after.detailPrunedRuns).toBe(1); // run-a; run-ancient is outside the window
    expect(after.runs).toBe(before.runs);
    expect(after.effectiveCostUsd).toBeCloseTo(before.effectiveCostUsd, 10);
    expect(after.inputTokens).toBe(before.inputTokens);
    db.close();
  });
});

describe("runtime stats: the lifetime denominator's upper bound", () => {
  test("a catalog whose oldest session is dated ahead of the clock reports no burn rate", () => {
    const { db } = fresh();
    // A clock corrected backwards leaves sessions dated after `now`. The
    // totals still count them — they happened — but `Math.max(1, …)` over a
    // negative span would report the whole catalog's spend as ONE day's.
    session(db, "s-future", NOW + 10 * DAY, NOW + 10 * DAY, 500, 20);
    const l = computeRuntimeStats(db, { days: 30, now: NOW }).lifetime;

    expect(l.sessions).toBe(1);
    expect(l.turns).toBe(20);
    expect(l.costUsd).toBeCloseTo(500, 10);
    expect(l.firstActivityAt).toBe(NOW + 10 * DAY);
    expect(l.elapsedDays).toBe(0);
    expect(l.averages.costUsdPerDay).toBeNull();
    expect(l.averages.costUsdPerMonth).toBeNull();
    // Per-session averages divide by the session count, not by the clock.
    expect(l.averages.costUsdPerSession).toBeCloseTo(500, 10);
    expect(l.averages.turnsPerSession).toBeCloseTo(20, 10);
    db.close();
  });

  test("a mixed catalog is unaffected: MIN picks the older row", () => {
    const { db } = fresh();
    session(db, "s-real", NOW - 40 * DAY, NOW - DAY, 2.0, 8);
    session(db, "s-future", NOW + 10 * DAY, NOW + 10 * DAY, 1.0, 2);
    const l = computeRuntimeStats(db, { days: 30, now: NOW }).lifetime;
    expect(l.elapsedDays).toBeCloseTo(40, 10);
    expect(l.costUsd).toBeCloseTo(3.0, 10);
    expect(l.averages.costUsdPerDay).toBeCloseTo(3.0 / 40, 10);
    db.close();
  });
});

describe("runtime stats: the window's upper bound", () => {
  test("a run dated after `until` is excluded — a corrected clock cannot inflate the figures", () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "real", {
      startedAt: NOW - 2 * DAY,
      endedAt: NOW - 2 * DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } }, // $0.30
      usage: { inputTokens: 100_000, costUsd: 0.5 },
    });
    // A clock corrected backwards leaves rows ahead of `now`. They are not
    // in [since, until] and must not be summed.
    finishedRun(store, "from-the-future", {
      startedAt: NOW + 5 * DAY,
      endedAt: NOW + 5 * DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 900_000 } },
      usage: { inputTokens: 900_000, costUsd: 9.0 },
    });

    const w = computeRuntimeStats(db, { days: 30, now: NOW }).window;
    expect(w.runs).toBe(1);
    expect(w.inputTokens).toBe(100_000);
    expect(w.costUsd).toBeCloseTo(0.5, 10);
    expect(w.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(w.recordedSince).toBe(NOW - 2 * DAY);
    expect(w.coveredDays).toBeCloseTo(2, 10);
    db.close();
  });

  test("a record made entirely of future rows reads as empty, not as a one-day burn", () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "future-only", {
      startedAt: NOW + DAY,
      endedAt: NOW + DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } },
      usage: { costUsd: 5.0 },
    });
    const w = computeRuntimeStats(db, { days: 30, now: NOW }).window;
    expect(w.runs).toBe(0);
    expect(w.costUsd).toBe(0);
    // recordedSince past `until` would have collapsed coveredDays to 1 and
    // reported the whole sum as a daily rate.
    expect(w.recordedSince).toBeNull();
    expect(w.coveredDays).toBe(0);
    expect(w.averages.runsPerDay).toBeNull();
    expect(w.averages.costUsdPerDay).toBeNull();
    db.close();
  });
});

describe("runtime stats: unpriced runs (AE3)", () => {
  test("an unpriced run is counted, excluded from the effective sum, and voids the effective averages", () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "priced", {
      startedAt: NOW - 2 * DAY,
      endedAt: NOW - 2 * DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } }, // $0.30
      usage: { costUsd: 0.5 },
    });
    finishedRun(store, "unpriced", {
      startedAt: NOW - DAY,
      endedAt: NOW - DAY + 1000,
      billing: "api",
      perModel: { "unknown-model": { inputTokens: 500 } }, // pricing does not know it
      usage: { costUsd: 0.2 },
    });
    const w = computeRuntimeStats(db, { days: 7, now: NOW }).window;
    expect(w.runs).toBe(2);
    expect(w.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(w.unpricedRuns).toBe(1);
    // The list-price sum has no unknown counter; it stays a floor, and its
    // per-day figure is derived from it as-is.
    expect(w.costUsd).toBeCloseTo(0.7, 10);
    expect(w.averages.costUsdPerDay).toBeCloseTo(0.7 / 2, 10);
    // An average over a partial sum would read as a rate — so it is null.
    expect(w.averages.effectiveCostUsdPerDay).toBeNull();
    expect(w.averages.effectiveCostUsdPerMonth).toBeNull();
    db.close();
  });

  test("a record where every run is unpriced never reads as $0", () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "r1", { startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 1000, usage: { costUsd: 0.1 } });
    finishedRun(store, "r2", { startedAt: NOW - DAY, endedAt: NOW - DAY + 1000, usage: { costUsd: 0.1 } });
    // Pre-feature rows: migration 010 backfills nothing, so present them the
    // way an upgraded database does.
    db.query(
      "UPDATE activity_run_rollups SET effective_cost_usd = NULL, billing_mode = NULL, pricing_estimate = NULL"
    ).run();
    const w = computeRuntimeStats(db, { days: 7, now: NOW }).window;
    expect(w.runs).toBe(2);
    expect(w.unpricedRuns).toBe(2);
    expect(w.effectiveCostUsd).toBe(0);
    expect(w.averages.effectiveCostUsdPerDay).toBeNull();
    // null must SURVIVE serialization — an omitted key would let a client
    // conflate unknown with zero.
    expect(JSON.stringify(w.averages)).toContain('"effectiveCostUsdPerDay":null');
    db.close();
  });
});

describe("runtime stats: the list-price axis has its own unpriced counter", () => {
  test("a run with a known effective cost but an unknown list price voids only the list-price average", () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "priced", {
      startedAt: NOW - 2 * DAY,
      endedAt: NOW - 2 * DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } }, // $0.30
      usage: { costUsd: 0.5 },
    });
    // Subscription-billed and the backend reported no cost: effective cost is
    // a KNOWN $0, list price is unknown. The two counters must disagree.
    finishedRun(store, "no-list-price", {
      startedAt: NOW - DAY,
      endedAt: NOW - DAY + 1000,
      billing: "subscription",
    });
    const w = computeRuntimeStats(db, { days: 7, now: NOW }).window;

    expect(w.runs).toBe(2);
    expect(w.unpricedRuns).toBe(0);
    expect(w.unpricedListCostRuns).toBe(1);
    expect(w.costUsd).toBeCloseTo(0.5, 10);
    // The list-price sum is a floor, so its rate would be a fabricated fact.
    expect(w.averages.costUsdPerDay).toBeNull();
    expect(w.averages.costUsdPerMonth).toBeNull();
    // The effective axis is complete, so its rate stands.
    expect(w.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(w.averages.effectiveCostUsdPerDay).toBeCloseTo(0.15, 10);
    // Both nulls must SURVIVE serialization.
    expect(JSON.stringify(w.averages)).toContain('"costUsdPerDay":null');
    db.close();
  });
});

describe("runtime stats: the empty database", () => {
  test("returns zeroes, null timestamps and null averages without throwing", () => {
    const { db } = fresh();
    const stats = computeRuntimeStats(db, { days: 30, now: NOW });
    expect(stats.lifetime).toEqual({
      scope: "lifetime",
      sessions: 0,
      turns: 0,
      costUsd: 0,
      firstActivityAt: null,
      lastActivityAt: null,
      elapsedDays: 0,
      averages: {
        costUsdPerSession: null,
        turnsPerSession: null,
        costUsdPerDay: null,
        costUsdPerMonth: null,
      },
    });
    expect(stats.window).toMatchObject({
      scope: "window",
      days: 30,
      recordedSince: null,
      coveredDays: 0,
      detailPrunedRuns: 0,
      runs: 0,
      failures: 0,
      costUsd: 0,
      effectiveCostUsd: 0,
      unpricedRuns: 0,
      unpricedListCostRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      averages: {
        runsPerDay: null,
        costUsdPerDay: null,
        costUsdPerMonth: null,
        effectiveCostUsdPerDay: null,
        effectiveCostUsdPerMonth: null,
      },
    });
    // No average is NaN or Infinity — every division has a guarded denominator.
    for (const v of [...Object.values(stats.lifetime.averages), ...Object.values(stats.window.averages)]) {
      expect(v).toBeNull();
    }
    expect(stats.database.sizeBytes).toBeGreaterThan(0);
    db.close();
  });
});

describe("runtime stats route", () => {
  test("GET /activity/stats serves the figures; days defaults to 30 and is clamped to 1..90", async () => {
    const { db, store } = fresh(rates);
    finishedRun(store, "recent", {
      startedAt: Date.now() - 2 * DAY,
      endedAt: Date.now() - 2 * DAY + 1000,
      billing: "api",
      perModel: { "claude-sonnet-4-6": { inputTokens: 100_000 } },
      usage: { costUsd: 0.5 },
    });
    session(db, "s-1", Date.now() - 2 * DAY, Date.now() - DAY, 0.5, 1);
    const app = createActivityRoutes({ db, store });

    const res = await app.request("/activity/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window.days).toBe(30);
    expect(body.window.runs).toBe(1);
    expect(body.window.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(body.lifetime.sessions).toBe(1);
    expect(body.database.sizeBytes).toBeGreaterThan(0);
    expect(typeof body.window.detailRetention.cutoffAt).toBe("number");

    expect((await (await app.request("/activity/stats?days=7")).json()).window.days).toBe(7);
    expect((await (await app.request("/activity/stats?days=400")).json()).window.days).toBe(90);
    expect((await (await app.request("/activity/stats?days=-5")).json()).window.days).toBe(1);
    // Zero and junk fall to the default, as they do on /activity/rollups.
    expect((await (await app.request("/activity/stats?days=0")).json()).window.days).toBe(30);
    expect((await (await app.request("/activity/stats?days=junk")).json()).window.days).toBe(30);
    // The window is whole days; a fraction truncates rather than riding
    // through into the documented shape.
    expect((await (await app.request("/activity/stats?days=2.7")).json()).window.days).toBe(2);
    db.close();
  });
});
