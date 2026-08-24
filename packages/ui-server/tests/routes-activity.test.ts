/**
 * The activity read API: run lists (live + history), the R26 resolution
 * rules (pruned resolves to rollup, unknown 404s), root-only aggregation,
 * the auth mount boundary, and the sessions listing's cost merge.
 */
import { describe, expect, test } from "bun:test";

import { createActivityNotifier } from "../src/activity/notify";
import { runActivityQuery } from "../src/activity/query";
import { createActivityStore, type ActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { createActivityRoutes } from "../src/routes/activity";
import { createSessionRoutes } from "../src/routes/sessions";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { setSetting } from "../src/db/settings";
import { makeFakeBackend } from "./helpers/fake-backend";

function seeded(): { db: ReturnType<typeof createUiDb>; store: ActivityStore } {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  // A finished successful turn with usage.
  store.startSpan({
    spanId: "turn-1:turn",
    runId: "turn-1",
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId: "sess-1",
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

  test("a pruned run resolves to its rollup; an unknown id 404s (R26)", async () => {
    const { db, store } = seeded();
    store.prune({ digestFloorAt: Date.now() + 1000, hardCeilingMs: 0 });
    const app = createActivityRoutes({ db, store });

    const pruned = await request(app, "/activity/runs/turn-1");
    expect(pruned.status).toBe(200);
    const body = await pruned.json();
    expect(body.detailPruned).toBe(true);
    expect(body.rollup.outcome).toBe("success");
    expect(body.rollup.costUsd).toBe(0.5);

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

describe("activity query inbox scope", () => {
  test("returns the unacknowledged intents through the notifier", () => {
    const { db, store } = seeded();
    // The notifier's change cursor starts at the log head, so it must exist
    // BEFORE the failure it is expected to notice.
    const notifier = createActivityNotifier({ db, store, isWatched: () => false });
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
