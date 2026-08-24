/**
 * The activity read API: run lists (live + history), the R26 resolution
 * rules (pruned resolves to rollup, unknown 404s), root-only aggregation,
 * the auth mount boundary, and the sessions listing's cost merge.
 */
import { describe, expect, test } from "bun:test";

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
  store.endSpan("cron-1:root", { outcome: "error", reason: "boom" });
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
    store.prune({ digestFloorMs: Date.now() + 1000, hardCeilingMs: 0 });
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

  test("an invalid configured zone degrades to UTC instead of failing the route", async () => {
    const { db, store } = seeded();
    setSetting(db, "activity.timezone", "Not/AZone");
    const app = createActivityRoutes({ db, store });
    const res = await request(app, "/activity/rollups");
    expect(res.status).toBe(200);
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
