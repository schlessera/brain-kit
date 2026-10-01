import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ActivityAggregate, ActivityRollups, ActivityRuntimeStats } from "@schlessera/brain-ui-sdk/protocol";

import { createActivityStore, type RollupPricing } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { createActivityRoutes } from "../src/routes/activity";

const costs = [
  { list: 0.123456, effective: 0.111156 },
  { list: 0.234567, effective: 0.222267 },
];

/** Real frozen rollups, with different list/effective prices on both origins. */
function seededPrecision() {
  const db = createUiDb(":memory:");
  const pricing: RollupPricing = {
    resolve: (model) => {
      const cost = costs[Number(model.slice("precision-".length))];
      return cost ? {
        input: cost.effective, output: 0, cacheRead: 0, cacheWrite: 0,
        estimate: false, source: "litellm",
      } : null;
    },
  };
  const store = createActivityStore(db, { writer: "test", pricing });
  // Noon UTC yesterday keeps every run on one completed day, even at midnight.
  const startedAt = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 43_200_000;
  for (const origin of ["session", "cron"] as const) {
    for (const [i, cost] of costs.entries()) {
      const runId = `${origin}-${i}`;
      store.startSpan({
        spanId: runId, runId, name: "precision fixture",
        kind: origin === "session" ? "turn" : "cron", origin, startedAt,
        ...(origin === "session" ? { sessionId: "ithaca" } : { jobName: "voyage" }),
        attrs: {
          "brain.billing_mode": "api",
          "gen_ai.usage.per_model": { [`precision-${i}`]: { inputTokens: 1 } },
        },
      });
      // Cron pricing reads agent child usage; the root still owns accounting.
      if (origin === "cron") {
        store.startSpan({
          spanId: `${runId}:agent`, runId, parentSpanId: runId,
          name: "invoke_agent", kind: "turn", origin, startedAt,
        });
        store.endSpan(`${runId}:agent`, {
          outcome: "success", endedAt: startedAt + 500,
          usage: { model: `precision-${i}`, inputTokens: 1 },
        });
      }
      store.endSpan(runId, {
        outcome: i === 0 ? "success" : "error", endedAt: startedAt + 1000,
        usage: {
          model: `precision-${i}`, costUsd: cost.list,
          inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4,
        },
      });
      store.rollupRun(runId);
    }
  }
  const app = new Hono().route("/api", createActivityRoutes({ db, store }));
  return { db, store, app };
}

async function readRollups(app: ReturnType<typeof seededPrecision>["app"]) {
  const res = await app.request("/api/activity/rollups?days=7");
  expect(res.status).toBe(200);
  const body = await res.json() as ActivityRollups;
  expect(body.days).toHaveLength(1);
  expect(body.jobs).toHaveLength(1);
  expect(body.sessions).toHaveLength(1);
  return body;
}

const rounded = {
  days: { costUsd: 0.716, effectiveCostUsd: 0.6668 },
  jobs: { costUsd: 0.358, effectiveCostUsd: 0.3334 },
  sessions: { costUsd: 0.358, effectiveCostUsd: 0.3334 },
};

describe("activity rollup response rounding (#692)", () => {
  // Separate cases keep one axis/group's failure from masking another's.
  for (const group of ["days", "jobs", "sessions"] as const) {
    for (const axis of ["costUsd", "effectiveCostUsd"] as const) {
      test(`${group} ${axis} rounds the completed multi-run sum to four decimals`, async () => {
        const { db, app } = seededPrecision();
        try {
          const body = await readRollups(app);
          const aggregate = body[group][0]!;
          expect(aggregate.runs).toBe(group === "days" ? 4 : 2);
          expect(aggregate[axis]).toBe(rounded[group][axis]);
        } finally { db.close(); }
      });
    }
  }

  test("storage, run detail and stats retain the same fixture's original precision", async () => {
    const { db, store, app } = seededPrecision();
    try {
      const before = db.query("SELECT run_id, cost_usd, effective_cost_usd FROM activity_run_rollups ORDER BY run_id").all();
      expect(before).toEqual(["cron", "session"].flatMap((origin) => costs.map((cost, i) => ({
        run_id: `${origin}-${i}`, cost_usd: cost.list, effective_cost_usd: cost.effective,
      }))));
      await readRollups(app);
      expect(db.query("SELECT run_id, cost_usd, effective_cost_usd FROM activity_run_rollups ORDER BY run_id").all()).toEqual(before);
      for (const [i, cost] of costs.entries()) {
        expect(store.getSpan(`session-${i}`)!.usage.costUsd).toBe(cost.list);
        const res = await app.request(`/api/activity/runs/session-${i}`);
        expect(res.status).toBe(200);
        const detail = await res.json();
        expect(detail.rollup.costUsd).toBe(cost.list);
        expect(detail.rollup.effectiveCostUsd).toBe(cost.effective);
      }
      const res = await app.request("/api/activity/stats?days=7");
      expect(res.status).toBe(200);
      const stats = await res.json() as ActivityRuntimeStats;
      expect(stats.window.runs).toBe(4);
      expect(stats.window.costUsd).toBe(0.716046);
      expect(stats.window.effectiveCostUsd).toBe(0.666846);
    } finally { db.close(); }
  });

  test("rounding preserves all counters and known-zero versus unknown effective costs", async () => {
    const { db, store, app } = seededPrecision();
    try {
      const body = await readRollups(app);
      for (const group of ["days", "jobs", "sessions"] as const) {
        const n = group === "days" ? 2 : 1;
        const aggregate: ActivityAggregate = body[group][0]!;
        expect(aggregate).toMatchObject({
          runs: 2 * n, failures: n, unpricedRuns: 0,
          inputTokens: 2 * n, outputTokens: 4 * n,
          cacheReadTokens: 6 * n, cacheCreationTokens: 8 * n, durationMs: 2000 * n,
        });
      }
      // One known subscription zero and one unknown run in each group.
      db.query("DELETE FROM activity_run_rollups").run();
      for (const origin of ["session", "cron"] as const) {
        for (const known of [true, false]) {
          const runId = `${origin}-${known}`;
          store.startSpan({
            spanId: runId, runId, name: "zero and unknown fixture",
            kind: origin === "session" ? "turn" : "cron", origin,
            ...(origin === "session" ? { sessionId: "ithaca" } : { jobName: "voyage" }),
            ...(known ? { attrs: { "brain.billing_mode": "subscription" } } : {}),
          });
          store.endSpan(runId, { outcome: "success", ...(known ? { usage: { costUsd: 0 } } : {}) });
          store.rollupRun(runId);
        }
      }
      const mixed = await readRollups(app);
      for (const group of ["days", "jobs", "sessions"] as const) {
        const n = group === "days" ? 2 : 1;
        expect(mixed[group][0]).toMatchObject({ runs: 2 * n, costUsd: 0, effectiveCostUsd: 0, unpricedRuns: n });
      }
      const res = await app.request("/api/activity/stats?days=7");
      expect(res.status).toBe(200);
      const stats = await res.json() as ActivityRuntimeStats;
      expect(stats.window).toMatchObject({ runs: 4, costUsd: 0, effectiveCostUsd: 0, unpricedRuns: 2, unpricedListCostRuns: 2 });
      expect(stats.window.averages.costUsdPerDay).toBeNull();
      expect(stats.window.averages.effectiveCostUsdPerDay).toBeNull();
    } finally { db.close(); }
  });
});
