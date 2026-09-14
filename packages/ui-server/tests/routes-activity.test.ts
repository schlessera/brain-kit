/**
 * The activity read API: run lists (live + history), the R26 resolution
 * rules (pruned resolves to rollup, unknown 404s), root-only aggregation,
 * the auth mount boundary, and the sessions listing's cost merge.
 */
import { describe, expect, test } from "bun:test";

import { createActivityNotifier } from "../src/activity/notify";
import { runActivityQuery } from "../src/activity/query";
import {
  createActivityStore,
  type ActivityStore,
  type RollupPricing,
} from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { createActivityRoutes } from "../src/routes/activity";
import { createSessionRoutes } from "../src/routes/sessions";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { setSetting } from "../src/db/settings";
import { makeFakeBackend } from "./helpers/fake-backend";

function seeded(): { db: ReturnType<typeof createUiDb>; store: ActivityStore } {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  db.query(
    `INSERT INTO principals
       (id, kind, auth_method, label, created_at, expires_at)
     VALUES ('principal-a', 'owner', 'password', 'Alex Example device', 1, ?)`
  ).run(Number.MAX_SAFE_INTEGER);
  // A finished successful turn with usage.
  store.startSpan({
    spanId: "turn-1:turn",
    runId: "turn-1",
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId: "sess-1",
    principalId: "principal-a",
    startedAt: Date.now() - 60_000,
  });
  store.endSpan("turn-1:turn", {
    outcome: "success",
    endedAt: Date.now() - 45_000,
    usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
  });
  store.rollupRun("turn-1");
  // A failed cron run.
  store.startSpan({
    spanId: "cron-1:root",
    runId: "cron-1",
    name: "cron sync",
    kind: "cron",
    origin: "cron",
    jobName: "sync",
    startedAt: Date.now() - 30_000,
  });
  store.endSpan("cron-1:root", { outcome: "error", reason: "boom", endedAt: Date.now() - 15_000 });
  store.rollupRun("cron-1");
  // A live run.
  store.startSpan({
    spanId: "turn-2:turn",
    runId: "turn-2",
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId: "sess-2",
  });
  return { db, store };
}

function request(app: ReturnType<typeof createActivityRoutes>, path: string) {
  return app.request(path);
}

describe("activity routes", () => {
  test("runs list splits live and history, newest first, with filters", async () => {
    const { db, store } = seeded();
    const app = createActivityRoutes({ db, store });

    const all = await (await request(app, "/activity/runs")).json();
    expect(all.live.map((r: any) => r.runId)).toEqual(["turn-2"]);
    expect(all.history.map((r: any) => r.runId)).toEqual(["cron-1", "turn-1"]);
    expect(all.history[0].outcome).toBe("error");
    expect(all.history[0].failureReason).toBe("boom");
    expect(all.history[0].principalId).toBeNull();
    expect(all.history[1]).toMatchObject({
      principalId: "principal-a",
      principalLabel: "Alex Example device",
      principalKind: "owner",
    });

    const cronOnly = await (await request(app, "/activity/runs?origin=cron")).json();
    expect(cronOnly.live).toHaveLength(0);
    expect(cronOnly.history.map((r: any) => r.runId)).toEqual(["cron-1"]);

    const failed = await (await request(app, "/activity/runs?status=error")).json();
    expect(failed.history.map((r: any) => r.runId)).toEqual(["cron-1"]);
    db.close();
  });

  test("run detail returns the span tree while retained", async () => {
    const { db, store } = seeded();
    const app = createActivityRoutes({ db, store });
    const res = await request(app, "/activity/runs/turn-1");
    const body = await res.json();
    expect(body.detailPruned).toBe(false);
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].outcome).toBe("success");
    expect(body.highWaterSeq).toBeGreaterThan(0);
    db.close();
  });

  test("run detail omits tool payload events unless ?include=payloads asks", async () => {
    const { db, store } = seeded();
    store.startSpan({
      spanId: "tool-x",
      runId: "turn-2",
      parentSpanId: "turn-2:turn",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
      sessionId: "sess-2",
    });
    store.appendEvent("tool-x", "tool_input", { file_path: "notes/a.md" });
    store.appendEvent("tool-x", "tool_output", "file contents");
    store.appendEvent("tool-x", "transcript_assistant", "reading the file");
    const app = createActivityRoutes({ db, store });

    // Default: the multi-KB payload events stay server-side; everything else
    // (transcripts included) still rides along.
    const slim = await (await request(app, "/activity/runs/turn-2")).json();
    expect(slim.events.map((e: any) => e.eventType)).toEqual(["transcript_assistant"]);
    expect(slim.spans.map((s: any) => s.spanId)).toContain("tool-x");

    // The drill-in opts in explicitly.
    const full = await (await request(app, "/activity/runs/turn-2?include=payloads")).json();
    expect(full.events.map((e: any) => e.eventType)).toEqual([
      "tool_input",
      "tool_output",
      "transcript_assistant",
    ]);
    db.close();
  });

  test("a pruned run resolves to its rollup; an unknown id 404s (R26)", async () => {
    const { db, store } = seeded();
    db.query("DELETE FROM principals WHERE id = 'principal-a'").run();
    store.prune({
      digestFloorAt: Date.now() + 1000,
      detailRetentionMs: 0,
      hardCeilingMs: 0,
      now: Date.now() + 1000,
    });
    const app = createActivityRoutes({ db, store });

    const pruned = await request(app, "/activity/runs/turn-1");
    expect(pruned.status).toBe(200);
    const body = await pruned.json();
    expect(body.detailPruned).toBe(true);
    expect(body.rollup.outcome).toBe("success");
    expect(body.rollup.costUsd).toBe(0.5);
    expect(body.rollup).toMatchObject({
      principalId: "principal-a",
      principalLabel: "Alex Example device",
      principalKind: "owner",
    });

    const unknown = await request(app, "/activity/runs/never-existed");
    expect(unknown.status).toBe(404);
    db.close();
  });

  test("rollups aggregate per day/job/session from root accounting, in the configured zone", async () => {
    const { db, store } = seeded();
    setSetting(db, "activity.timezone", "Europe/Berlin");
    const app = createActivityRoutes({ db, store });
    const body = await (await request(app, "/activity/rollups?days=7")).json();
    expect(body.timeZone).toBe("Europe/Berlin");
    expect(body.days).toHaveLength(1);
    expect(body.days[0].runs).toBe(2);
    expect(body.days[0].failures).toBe(1);
    expect(body.days[0].costUsd).toBeCloseTo(0.5);
    expect(body.jobs.find((j: any) => j.jobName === "sync").failures).toBe(1);
    expect(body.sessions.find((s: any) => s.sessionId === "sess-1").inputTokens).toBe(1000);
    // The effective pair is ALWAYS present on every aggregate — a client must
    // never have to treat its absence as $0.
    for (const agg of [...body.days, ...body.jobs, ...body.sessions]) {
      expect(typeof agg.effectiveCostUsd).toBe("number");
      expect(typeof agg.unpricedRuns).toBe("number");
    }
    db.close();
  });

  test("a negative or zero limit is clamped, never a throw or an unbounded read", async () => {
    const { db, store } = seeded();
    const app = createActivityRoutes({ db, store });
    for (const q of ["-1", "0", "junk"]) {
      const res = await request(app, `/activity/runs?limit=${q}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.history.length).toBeLessThanOrEqual(200);
    }
    db.close();
  });

  test("digest lifecycle over the routes: absent, generated, dismissed, idempotent", async () => {
    const { db, store } = seeded();
    const app = createActivityRoutes({ db, store });

    // Before the first generation there is no digest.
    let body = await (await request(app, "/activity/digest")).json();
    expect(body.digest).toBeNull();

    const gen = await app.request("/activity/digest/generate", { method: "POST" });
    expect(gen.status).toBe(200);
    expect((await gen.json()).digest.runs).toBe(2);

    body = await (await request(app, "/activity/digest")).json();
    expect(body.digest.runs).toBe(2);
    expect(body.dismissedAt).toBe(0);

    const dismiss = await app.request("/activity/digest/dismiss", { method: "POST" });
    expect((await dismiss.json()).ok).toBe(true);
    body = await (await request(app, "/activity/digest")).json();
    expect(body.dismissedAt).toBeGreaterThan(0);

    // Dismiss is idempotent — a second call is a fresh ok, not an error.
    const again = await app.request("/activity/digest/dismiss", { method: "POST" });
    expect((await again.json()).ok).toBe(true);
    db.close();
  });

  test("an invalid configured zone degrades to UTC instead of failing the route", async () => {
    const { db, store } = seeded();
    setSetting(db, "activity.timezone", "Not/AZone");
    const app = createActivityRoutes({ db, store });
    const res = await request(app, "/activity/rollups");
    expect(res.status).toBe(200);
    db.close();
  });
});

describe("activity aggregation: effective cost + unpriced counts (U5)", () => {
  /** Fake pricing — sync + local, mirroring the store test's seam. */
  const rates: RollupPricing = {
    resolve: (modelId) =>
      modelId === "claude-sonnet-4-6"
        ? { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6, estimate: false, source: "litellm" }
        : null,
  };

  /**
   * A mixed window (AE3): one subscription run (effective $0), one priced
   * api run ($0.30), one api run on a model pricing does not know (NULL),
   * plus two cron runs on one job — one subscription, one unknowable.
   */
  function seededPriced() {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "test", pricing: rates });
    const sessionRun = (
      runId: string,
      billing: "subscription" | "api",
      perModel?: Record<string, { inputTokens: number }>
    ) => {
      store.startSpan({
        spanId: `${runId}:turn`,
        runId,
        name: "invoke_agent",
        kind: "turn",
        origin: "session",
        sessionId: "sess-1",
        attrs: { "brain.billing_mode": billing, "brain.profile_id": "default" },
        startedAt: Date.now() - 60_000,
      });
      store.endSpan(`${runId}:turn`, {
        outcome: "success",
        endedAt: Date.now() - 45_000,
        ...(perModel ? { attrs: { "gen_ai.usage.per_model": perModel } } : {}),
      });
      store.rollupRun(runId);
    };
    sessionRun("sub-1", "subscription", { "claude-sonnet-4-6": { inputTokens: 1000 } });
    sessionRun("api-1", "api", { "claude-sonnet-4-6": { inputTokens: 100_000 } });
    sessionRun("api-null", "api", { "unknown-model": { inputTokens: 500 } });
    const cronRun = (runId: string, billing: "subscription" | "api") => {
      store.startSpan({
        spanId: `${runId}:root`,
        runId,
        name: "cron sync",
        kind: "cron",
        origin: "cron",
        jobName: "sync",
        attrs: { "brain.billing_mode": billing },
        startedAt: Date.now() - 30_000,
      });
      store.endSpan(`${runId}:root`, { outcome: "success", endedAt: Date.now() - 15_000 });
      store.rollupRun(runId);
    };
    cronRun("cron-sub", "subscription");
    cronRun("cron-null", "api"); // no usage recorded at all → effective NULL
    return { db, store };
  }

  test("rollups route sums only priced runs and counts the NULLs at every group (AE3)", async () => {
    const { db, store } = seededPriced();
    const app = createActivityRoutes({ db, store });
    const body = await (await request(app, "/activity/rollups?days=7")).json();

    expect(body.days).toHaveLength(1);
    expect(body.days[0].runs).toBe(5);
    // 100k input tokens at $3/M — the sub run's tokens and the two NULL runs
    // contribute NOTHING (not $0 folded in silently: the count carries them).
    expect(body.days[0].effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(body.days[0].unpricedRuns).toBe(2);

    const sess = body.sessions.find((s: any) => s.sessionId === "sess-1");
    expect(sess.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(sess.unpricedRuns).toBe(1);

    const job = body.jobs.find((j: any) => j.jobName === "sync");
    expect(job.effectiveCostUsd).toBe(0); // subscription $0 is a KNOWN zero
    expect(job.unpricedRuns).toBe(1);
    db.close();
  });

  test("run summaries and the pruned detail rollup carry the effective triple", async () => {
    const { db, store } = seededPriced();
    const app = createActivityRoutes({ db, store });

    const runs = await (await request(app, "/activity/runs")).json();
    const priced = runs.history.find((r: any) => r.runId === "api-1");
    expect(priced.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(priced.billingMode).toBe("api");
    expect(priced.pricingEstimate).toBe(false);
    const unknown = runs.history.find((r: any) => r.runId === "api-null");
    expect(unknown.effectiveCostUsd).toBeNull();
    expect(unknown.billingMode).toBe("api");
    expect("pricingEstimate" in unknown).toBe(false); // unknown, not false

    store.prune({
      digestFloorAt: Date.now() + 1000,
      detailRetentionMs: 0,
      hardCeilingMs: 0,
      now: Date.now() + 1000,
    });
    const detail = await (await request(app, "/activity/runs/api-1")).json();
    expect(detail.detailPruned).toBe(true);
    expect(detail.rollup.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(detail.rollup.billingMode).toBe("api");
    db.close();
  });

  test("a window entirely pre-feature (all NULL) sums to 0 with unpricedRuns = run count", async () => {
    const { db, store } = seededPriced();
    // Pre-feature rows: migration 010 backfills nothing, so simulate by
    // clearing the columns the way an upgraded DB presents them.
    db.query(
      "UPDATE activity_run_rollups SET effective_cost_usd = NULL, billing_mode = NULL, pricing_estimate = NULL"
    ).run();
    const app = createActivityRoutes({ db, store });
    const body = await (await request(app, "/activity/rollups?days=7")).json();
    expect(body.days[0].effectiveCostUsd).toBe(0);
    expect(body.days[0].unpricedRuns).toBe(body.days[0].runs);
    db.close();
  });

  test("query_activity scope=run carries the frozen cost triple while detail is retained", () => {
    const { db, store } = seededPriced();

    // Finished, NOT pruned — the common case, which previously dropped the
    // triple entirely. Explicit values, mirroring the REST detail route.
    const priced = runActivityQuery(db, store, { scope: "run", runId: "api-1" }) as Record<
      string,
      unknown
    >;
    expect(priced.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(priced.billingMode).toBe("api");
    expect(priced.pricingEstimate).toBe(false);
    expect(priced.failureReason).toBeNull();
    expect(Array.isArray(priced.spans)).toBe(true);

    // Unknown effective cost stays an explicit null, never omitted.
    const unknown = runActivityQuery(db, store, { scope: "run", runId: "api-null" });
    expect(JSON.stringify(unknown)).toContain('"effectiveCostUsd":null');
    expect(JSON.stringify(unknown)).toContain('"billingMode":"api"');

    // A still-running run has no rollup yet — everything unknown, spans served.
    store.startSpan({
      spanId: "live-1:turn",
      runId: "live-1",
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId: "sess-1",
    });
    const live = runActivityQuery(db, store, { scope: "run", runId: "live-1" }) as Record<
      string,
      unknown
    >;
    expect(live.effectiveCostUsd).toBeNull();
    expect(live.billingMode).toBeNull();
    expect(Array.isArray(live.spans)).toBe(true);

    // The never-existed error path is untouched.
    expect(runActivityQuery(db, store, { scope: "run", runId: "nope" })).toEqual({
      error: "unknown run nope",
    });
    db.close();
  });

  test("query_activity scopes emit explicit nulls and the aggregate pair (AE3)", () => {
    const { db, store } = seededPriced();

    const recent = runActivityQuery(db, store, { scope: "recent" }) as {
      finished: Array<Record<string, unknown>>;
    };
    const priced = recent.finished.find((r) => r.runId === "api-1")!;
    expect(priced.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(priced.billingMode).toBe("api");
    expect(priced.pricingEstimate).toBe(false);
    const unknown = recent.finished.find((r) => r.runId === "api-null")!;
    // null must SURVIVE serialization — an omitted key would let the model
    // conflate unknown with zero.
    expect(JSON.stringify(unknown)).toContain('"effectiveCostUsd":null');
    expect(JSON.stringify(unknown)).toContain('"pricingEstimate":null');

    const rollups = runActivityQuery(db, store, { scope: "rollups" }) as Record<string, unknown>;
    expect(rollups.effectiveCostUsd).toBeCloseTo(0.3, 10);
    expect(rollups.unpricedRuns).toBe(2);

    store.prune({
      digestFloorAt: Date.now() + 1000,
      detailRetentionMs: 0,
      hardCeilingMs: 0,
      now: Date.now() + 1000,
    });
    const run = runActivityQuery(db, store, { scope: "run", runId: "api-null" }) as {
      rollup: Record<string, unknown>;
    };
    expect(JSON.stringify(run.rollup)).toContain('"effectiveCostUsd":null');
    db.close();
  });
});

describe("activity query inbox scope", () => {
  test("returns the unacknowledged intents through the notifier", () => {
    const { db, store } = seeded();
    // Startup replays the seeded failure; acknowledge it before a new run
    // of the same job so tag dedupe does not coalesce the new notification.
    const notifier = createActivityNotifier({ db, store, isWatched: () => false });
    notifier.tick();
    expect(notifier.inbox()[0]?.runId).toBe("cron-1");
    notifier.acknowledgeAll();
    store.startSpan({
      spanId: "cron-2:root",
      runId: "cron-2",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    store.endSpan("cron-2:root", { outcome: "error", reason: "boom" });
    notifier.tick();

    const result = runActivityQuery(db, store, { scope: "inbox" }, notifier) as {
      intents: Array<Record<string, unknown>>;
    };
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toMatchObject({
      kind: "failure",
      status: "pending",
      runId: "cron-2",
    });
    expect(result.intents[0]!.title).toContain("sync");
    expect(typeof result.intents[0]!.createdAt).toBe("string");

    // Acknowledged intents leave the inbox view.
    notifier.acknowledgeAll();
    const after = runActivityQuery(db, store, { scope: "inbox" }, notifier) as {
      intents: unknown[];
    };
    expect(after.intents).toHaveLength(0);
    db.close();
  });

  test("without a notifier the scope degrades to an explicit error", () => {
    const { db, store } = seeded();
    expect(runActivityQuery(db, store, { scope: "inbox" })).toEqual({
      error: "inbox unavailable",
    });
    db.close();
  });
});

describe("sessions cost merge", () => {
  test("stored accounting fills a backend's hardcoded zeros", async () => {
    const db = createUiDb(":memory:");
    db.prepare(
      "INSERT INTO sessions (id, created_at, last_active_at, total_cost_usd, num_turns) VALUES ('s1', 1, 2, 1.25, 4)"
    ).run();
    const backend = makeFakeBackend({
      id: "fake",
      sessions: [
        {
          id: "s1",
          title: "t",
          createdAt: 1,
          lastActiveAt: 2,
          totalCostUsd: 0,
          numTurns: 0,
        },
      ],
    });
    const app = createSessionRoutes({
      registry: createStaticBackendRegistry([backend], backend.id),
      db,
    });
    const body = await (await app.request("/sessions")).json();
    expect(body.sessions[0].totalCostUsd).toBe(1.25);
    expect(body.sessions[0].numTurns).toBe(4);
    db.close();
  });
});
