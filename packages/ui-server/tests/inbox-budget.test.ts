import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { PricingRates } from "../src/pricing/model-pricing.js";
import { createUiDb } from "../src/db/client.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";

import { createInboxBudget, acquireInboxBudgetRun, inboxBudgetDay, type InboxBudgetOperation } from "../src/inbox/budget.js";

import { createActivityStore } from "../src/activity/store.js";

import { resolveServerConfig } from "../src/config/env.js";

// The runtime must check the same durable ledger inside each real claim.
test("in-flight reservations prevent a second runtime from starting over-cap work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-budget-race-"));
  const path = join(dir, "ui.db"), a = createUiDb(path), b = createUiDb(path);
  const now = Date.UTC(2026, 9, 1), s = createInboxStore(a, { now: () => now });
  for (const id of ["odysseus", "penelope"]) s.ingest({ threadId: id, itemId: id, dedupKey: id,
    stagingId: id, source: "share", stakes: 2, expiresAt: now + 86_400_000 });
  let starts = 0;
  const releases: Array<() => void> = [];
  const options = {
    log: { emit() {}, enabled: () => false }, now: () => now,
    budget: { config: { spendUsd: 5, turns: 10, emergencySpendUsd: 0, emergencyTurns: 0,
      timeZone: "UTC", unpricedUsdPerToken: 0.01 },
      pricing: { resolve: () => ({ input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } },
    operation: (item: { id: string }) => ({ runId: `run-${item.id}`, principalId: "owner", model: "fixture",
      billingMode: "api", purpose: "execute", maximumTokens: { inputTokens: 1000, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    dispatch: async () => { starts++; await new Promise<void>((resolve) => releases.push(resolve)); },
  };
  const one = createInboxRuntime(a, options as Parameters<typeof createInboxRuntime>[1]);
  const two = createInboxRuntime(b, options as Parameters<typeof createInboxRuntime>[1]);
  const first = one.tick(); await Bun.sleep(0);
  const second = two.tick(); await Bun.sleep(0);
  try {
    expect(starts).toBe(1);
    expect(s.snapshot().items.filter((item) => item.status === "ready")).toHaveLength(1);
  } finally {
    for (const release of releases) release();
    await Promise.all([first, second]); await one.close(); await two.close();
    a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
  }
});


const rates = { input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" as const };
const start = Date.UTC(2026, 9, 1, 12);
function fixture(overrides: Partial<Parameters<typeof createInboxBudget>[1]["config"]> = {}, price: PricingRates | null = rates) {
  const db = createUiDb(":memory:"); let at = start;
  const store = createInboxStore(db, { now: () => at });
  const config = { spendUsd: 5, turns: 10, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01, ...overrides };
  const pricing = { resolve: () => price };
  const budget = createInboxBudget(db, { config, pricing, now: () => at });
  const activity = createActivityStore(db, { pricing });
  function seed(id: string) { store.ingest({ threadId: id, itemId: id, dedupKey: id, stagingId: id, source: "share", stakes: 2, expiresAt: at + 86_400_000 }); }
  function operation(id: string, changes: Partial<InboxBudgetOperation> = {}): InboxBudgetOperation {
    return { runId: id, principalId: "owner", model: "fixture", billingMode: "api", purpose: "execute",
      maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, ...changes };
  }
  function claim(id: string, changes: Partial<InboxBudgetOperation> = {}) { seed(id); return budget.claim(id, operation(`run-${id}`, changes), at + 600_000); }
  function receipt(id: string, counts: Record<string, unknown> | null = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, billing: "api" | "subscription" = "api", terminal = true, observedBilling?: string) {
    const runId = `run-${id}`;
    activity.startSpan({ spanId: runId, runId, name: "Odysseus fixture", kind: "turn", origin: "autonomous", startedAt: at,
      attrs: { "brain.billing_mode": billing, ...(observedBilling ? { "brain.billing_observed": observedBilling } : {}),
        ...(counts ? { "gen_ai.usage.per_model": { fixture: counts } } : {}) } });
    if (terminal) activity.endSpan(runId, { outcome: "success" });
    activity.rollupRun(runId);
  }
  const row = (id: string) => db.query("SELECT * FROM inbox_budget_reservations WHERE run_id = ?").get(`run-${id}`) as Record<string, unknown>;
  return { db, store, config, pricing, budget, activity, seed, operation, claim, receipt, row, setTime: (value: number) => { at = value; } };
}

describe("durable budget settlement", () => {
  test("the default autonomous pool stops a third claim before any attempt or reservation", () => {
    const f = fixture({ spendUsd: 50 });
    try {
      expect(f.claim("odysseus")).not.toBeNull();
      expect(f.claim("penelope")).not.toBeNull();
      const rejected = f.claim("telemachus");
      expect(rejected).toBeNull();
      expect(f.store.getItem("telemachus")).toMatchObject({ status: "ready", attempts: 0 });
      expect(f.row("telemachus")).toBeNull();
    } finally { f.db.close(); }
  });
  test("terminal Activity rollup releases unused money exactly once and freezes the receipt", () => {
    const f = fixture();
    try {
      expect(f.claim("odysseus")).not.toBeNull();
      f.receipt("odysseus");
      expect(f.row("odysseus")).toMatchObject({ status: "settled", observed_cost_usd: 0.3, charged_cost_usd: 0.3, charged_turns: 1 });
      const before = f.row("odysseus");
      expect(f.budget.settle("run-odysseus")).toBe(false);
      f.activity.rollupRun("run-odysseus");
      expect(f.row("odysseus")).toEqual(before);
      expect(f.claim("penelope")).not.toBeNull();
      expect(f.budget.totals().normal).toEqual({ cost: 3_300_000, turns: 2 });
      expect(() => f.db.query("UPDATE inbox_budget_reservations SET charged_cost_usd = 0 WHERE run_id = 'run-odysseus'").run()).toThrow("Frozen inbox budget settlement");
    } finally { f.db.close(); }
  });
  test("a live partial rollup cannot prematurely settle or free a running reservation", () => {
    const f = fixture();
    try {
      f.claim("odysseus"); f.receipt("odysseus", undefined, "api", false);
      expect(f.row("odysseus")).toMatchObject({ status: "active", charged_cost_usd: null });
      expect(f.budget.settle("run-odysseus")).toBe(false);
      expect(f.claim("penelope")).toBeNull();
    } finally { f.db.close(); }
  });
  for (const counts of [null, {}, { inputTokens: "missing" }, { inputTokens: 0 }, { inputTokens: 100 }]) {
    test(`missing or unusable API usage retains reservation: ${JSON.stringify(counts)}`, () => {
      const f = fixture();
      try {
        f.claim("odysseus"); f.receipt("odysseus", counts);
        expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 3 });
        expect(f.claim("penelope")).toBeNull();
      } finally { f.db.close(); }
    });
  }
  test("explicit zero-token usage is zero while an empty per-model object is unknown", () => {
    const f = fixture();
    try {
      f.claim("odysseus"); f.receipt("odysseus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
      expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: 0, charged_cost_usd: 0, charged_turns: 1 });
      expect(f.budget.totals().unpricedRuns).toBe(0);
    } finally { f.db.close(); }
  });
  test("unpriced API tokens use the frozen pessimistic rate with one per-model Action", () => {
    const f = fixture({}, null);
    try {
      for (const id of ["odysseus", "penelope"]) {
        expect(f.claim(id, { maximumTokens: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } })).not.toBeNull();
        f.receipt(id, { inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
        expect(f.row(id)).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 0.2 });
      }
      expect(f.budget.totals().unpricedRuns).toBe(2);
      expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "choose")).toHaveLength(1);
      expect(f.store.snapshot().items.find((item) => item.queue === "actions")!.queue).toBe("actions");
    } finally { f.db.close(); }
  });
  test("unpriced API without usable admission counts stays ready and consumes no attempt", () => {
    const f = fixture({}, null);
    try {
      expect(f.claim("odysseus", { maximumTokens: undefined })).toBeNull();
      expect(f.store.getItem("odysseus")).toMatchObject({ status: "ready", attempts: 0 });
      expect(f.budget.totals().normal).toEqual({ cost: 0, turns: 0 });
    } finally { f.db.close(); }
  });
  test("unpriced subscription moves only turns and emits no pricing Action", () => {
    const f = fixture({ turns: 1 }, null);
    try {
      expect(f.claim("odysseus", { billingMode: "subscription", maximumTokens: undefined })).not.toBeNull();
      f.receipt("odysseus", null, "subscription");
      expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: 0, charged_cost_usd: 0, charged_turns: 1 });
      expect(f.store.snapshot().items.filter((item) => item.queue === "actions")).toHaveLength(0);
      expect(f.claim("penelope", { billingMode: "subscription", maximumTokens: undefined })).toBeNull();
      expect(f.budget.totals().normal).toEqual({ cost: 0, turns: 1 });
      expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
    } finally { f.db.close(); }
  });
  test("observed API billing contradicting subscription is charged rather than erased", () => {
    const f = fixture();
    try {
      f.claim("odysseus", { billingMode: "subscription" });
      f.receipt("odysseus", undefined, "subscription", true, "api");
      expect(f.row("odysseus")).toMatchObject({ observed_billing_mode: "api", charged_cost_usd: 0.3 });
    } finally { f.db.close(); }
  });
  test("emergency pool has independent and combined hard ceilings and one durable FYI", () => {
    const f = fixture({ spendUsd: 3, turns: 1, emergencySpendUsd: 3, emergencyTurns: 1 });
    try {
      expect(f.claim("odysseus")).not.toBeNull();
      expect(f.claim("normal-deferred")).toBeNull();
      expect(f.claim("penelope", { emergency: true })).not.toBeNull();
      expect(f.claim("reserve-deferred", { emergency: true })).toBeNull();
      expect(f.budget.totals()).toMatchObject({ normal: { cost: 3_000_000, turns: 1 }, emergency: { cost: 3_000_000, turns: 1 } });
      expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
      const restarted = createInboxBudget(f.db, { config: f.config, pricing: f.pricing });
      expect(restarted.claim("reserve-deferred", f.operation("later", { emergency: true }), Date.now() + 600_000)).toBeNull();
      expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
    } finally { f.db.close(); }
  });
  test("local admission day survives midnight and DST rather than using settlement time", () => {
    const f = fixture({ timeZone: "America/New_York" });
    try {
      f.setTime(Date.UTC(2026, 10, 1, 3, 59)); // 23:59 on October 31, before DST ends.
      f.claim("odysseus");
      expect(f.row("odysseus").local_day).toBe("2026-10-31");
      f.setTime(Date.UTC(2026, 10, 1, 6, 30));
      f.receipt("odysseus");
      expect(f.row("odysseus").local_day).toBe("2026-10-31");
      expect(f.budget.totals("2026-10-31").normal).toEqual({ cost: 300_000, turns: 1 });
      expect(f.budget.totals("2026-11-01").normal).toEqual({ cost: 0, turns: 0 });
      expect(inboxBudgetDay(Date.UTC(2026, 9, 1, 0), "Pacific/Honolulu")).toBe("2026-09-30");
      expect(inboxBudgetDay(Date.UTC(2026, 9, 1, 0), "Pacific/Kiritimati")).toBe("2026-10-01");
    } finally { f.db.close(); }
  });
  for (const purpose of ["triage", "execute", "retry", "redo", "compaction"] as const) {
    test(`${purpose} consumes a reservation and cannot re-acquire a backend`, () => {
      const f = fixture({ turns: 1 });
      try {
        expect(f.claim("odysseus", { purpose })).not.toBeNull();
        acquireInboxBudgetRun(f.db, "run-odysseus", "owner", start);
        expect(() => acquireInboxBudgetRun(f.db, "run-odysseus", "owner", start)).toThrow("unused active budget");
        expect(f.claim("penelope", { purpose })).toBeNull();
        expect(f.row("odysseus")).toMatchObject({ purpose, reserved_turns: 1 });
      } finally { f.db.close(); }
    });
  }
  test("unaccounted autonomous history blocks admission; interactive history does not consume this cap", () => {
    const f = fixture();
    try {
      f.activity.startSpan({ spanId: "interactive", runId: "interactive", name: "fixture", kind: "turn", origin: "session", startedAt: start });
      f.activity.endSpan("interactive", { outcome: "success", usage: { costUsd: 100 } }); f.activity.rollupRun("interactive");
      expect(f.claim("odysseus")).not.toBeNull();
      f.activity.startSpan({ spanId: "unreserved", runId: "unreserved", name: "fixture", kind: "turn", origin: "autonomous", startedAt: start });
      expect(f.claim("penelope")).toBeNull();
      expect(f.budget.totals().unpricedRuns).toBe(1);
    } finally { f.db.close(); }
  });
});


test("conservative admission retains a reported overrun and refuses later work", () => {
  const f = fixture({ spendUsd: 3, emergencySpendUsd: 3, emergencyTurns: 2 });
  try {
    expect(f.claim("odysseus")).not.toBeNull();
    f.receipt("odysseus", { inputTokens: 1500, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(f.row("odysseus")).toMatchObject({ charged_cost_usd: 4.5 });
    expect(f.claim("penelope")).toBeNull();
    expect(f.claim("reserve", { emergency: true })).toBeNull();
    expect(f.budget.totals().normal.cost).toBe(4_500_000);
  } finally { f.db.close(); }
});

test("yield retains observed costs, returns work to ready and preserves the spent turn", () => {
  const f = fixture();
  try {
    f.claim("odysseus"); f.receipt("odysseus");
    expect(f.budget.settle("run-odysseus", "released")).toBe(false); // already settled at rollup
    f.store.commit([{ kind: "transition", itemId: "odysseus", expectedVersion: 2, to: "ready" }]);
    expect(f.budget.recover()).toBe(0);
    expect(f.store.getItem("odysseus")).toMatchObject({ status: "ready", attempts: 1 });
    expect(f.row("odysseus")).toMatchObject({ charged_cost_usd: 0.3, charged_turns: 1 });
    expect(f.budget.claim("odysseus", f.operation("redo", { purpose: "redo" }), start + 600_000)).not.toBeNull();
    expect(f.budget.totals().normal).toEqual({ cost: 3_300_000, turns: 2 });
  } finally { f.db.close(); }
});

test("a reopened mid-run crash reconciles spend before the lease becomes ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-budget-crash-")), path = join(dir, "ui.db");
  let db = createUiDb(path), at = start;
  const config = { spendUsd: 5, turns: 10, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 };
  let runtime: ReturnType<typeof createInboxRuntime> | undefined;
  try {
    const s = createInboxStore(db, { now: () => at });
    for (const id of ["odysseus", "penelope"]) s.ingest({ threadId: id, itemId: id, dedupKey: id, stagingId: id, source: "share", stakes: 2, expiresAt: at + 86_400_000 });
    const budget = createInboxBudget(db, { config, pricing: { resolve: () => rates }, now: () => at });
    expect(budget.claim("odysseus", { runId: "crashed", principalId: "owner", model: "fixture", billingMode: "api", purpose: "execute",
      maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }, at + 1)).not.toBeNull();
    const activity = createActivityStore(db, { pricing: { resolve: () => rates } });
    activity.startSpan({ spanId: "crashed", runId: "crashed", name: "fixture", origin: "autonomous", kind: "turn", startedAt: at,
      attrs: { "brain.billing_mode": "api", "gen_ai.usage.per_model": { fixture: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } } });
    activity.rollupRun("crashed");
    db.close(); db = createUiDb(path); at++;
    let starts = 0;
    runtime = createInboxRuntime(db, { log: { emit() {}, enabled: () => false }, now: () => at,
      budget: { config, pricing: { resolve: () => rates } }, operation: (item) => ({ runId: `retry-${item.id}`, principalId: "owner", model: "fixture", billingMode: "api", purpose: "retry",
        maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }), dispatch: async () => { starts++; } });
    const recovered = db.query("SELECT status, observed_cost_usd, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'crashed'").get();
    expect(recovered).toEqual({ status: "released", observed_cost_usd: 0.3, charged_cost_usd: 3, charged_turns: 1 });
    expect(createInboxStore(db).getItem("odysseus")).toMatchObject({ status: "ready", attempts: 1 });
    await runtime.tick(); expect(starts).toBe(0);
    expect(createInboxBudget(db, { config, pricing: { resolve: () => rates }, now: () => at }).totals().normal).toEqual({ cost: 3_000_000, turns: 1 });
  } finally { await runtime?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
  test(`each billable token class contributes to reservation and settlement: ${field}`, () => {
    const f = fixture();
    const counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, [field]: 100 };
    try {
      expect(f.claim("odysseus", { maximumTokens: { ...counts, [field]: 1000 } })).not.toBeNull();
      f.receipt("odysseus", counts);
      expect(f.row("odysseus")).toMatchObject({ reserved_cost_usd: 3, charged_cost_usd: 0.3 });
    } finally { f.db.close(); }
  });
}

test("a T1 batch claims its items atomically under one model-operation reservation", () => {
  const f = fixture();
  try {
    f.seed("odysseus"); f.seed("penelope");
    expect(f.budget.claim(["odysseus", "penelope"], f.operation("batch", { purpose: "triage" }), start + 600_000)?.items).toHaveLength(2);
    expect(f.store.snapshot().items.filter((item) => item.status === "claimed")).toHaveLength(2);
    expect(f.budget.totals().normal).toEqual({ cost: 3_000_000, turns: 1 });
  } finally { f.db.close(); }
});

test("admission rollback does not leave a claim when a reservation write fails", () => {
  const f = fixture();
  try {
    f.seed("odysseus");
    f.db.exec("CREATE TRIGGER fixture_reservation_failure BEFORE INSERT ON inbox_budget_reservations BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    expect(() => f.budget.claim("odysseus", f.operation("refused"), start + 600_000)).toThrow("fixture rollback");
    expect(f.store.getItem("odysseus")).toMatchObject({ status: "ready", attempts: 0 });
    expect(f.budget.totals().normal).toEqual({ cost: 0, turns: 0 });
  } finally { f.db.close(); }
});

test("autonomous budget config defaults pause turns and reject unsafe numeric/timezone values", () => {
  expect(resolveServerConfig({}).inbox!.budget).toEqual({ spendUsd: 5, turns: 0, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 });
  for (const [name, value] of Object.entries({ BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY: "-1", BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY: "1.5",
    BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD: "Infinity", BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS: "invalid", BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN: "0", BRAIN_UI_AUTONOMOUS_TIMEZONE: "invalid" })) {
    expect(() => resolveServerConfig({ [name]: value })).toThrow(name);
  }
});

test("autonomous capacity and yield configuration are bounded without enabling dispatch", () => {
  expect(resolveServerConfig({}).inbox).toMatchObject({ maxAutonomousRuns: 2, yieldAfterMs: 20_000 });
  expect(resolveServerConfig({ MAX_AUTONOMOUS_RUNS: "1", BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS: "15000" }).inbox)
    .toMatchObject({ maxAutonomousRuns: 1, yieldAfterMs: 15_000, budget: { turns: 0 } });
  for (const [name, values] of [["MAX_AUTONOMOUS_RUNS", ["", "0", "-1", "1.5", "Infinity"]],
    ["BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS", ["", "0", "-1", "1.5", "30000", "Infinity"]]] as const) {
    for (const value of values) expect(() => resolveServerConfig({ [name]: value })).toThrow(name);
  }
});

test("missing usage after an observed API/subscription mismatch cannot become a free call", () => {
  const f = fixture();
  try {
    f.claim("odysseus", { billingMode: "subscription", maximumTokens: undefined });
    f.receipt("odysseus", null, "subscription", true, "api");
    expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 5, observed_billing_mode: "api" });
    expect(f.claim("penelope")).toBeNull();
    expect(f.budget.totals().unpricedRuns).toBe(1);
  } finally { f.db.close(); }
});

test("an explicitly unknown runtime billing observation cannot prove subscription zero", () => {
  const f = fixture();
  try {
    f.claim("odysseus", { billingMode: "subscription" });
    f.receipt("odysseus", null, "subscription", true, "unknown");
    expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 3, observed_billing_mode: null });
  } finally { f.db.close(); }
});

test("all contributors to per-model API usage are counted without double-counting subagents", () => {
  const f = fixture({}, null);
  try {
    f.claim("odysseus", { maximumTokens: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    f.activity.startSpan({ spanId: "multi", runId: "run-odysseus", name: "fixture", kind: "turn", origin: "autonomous", startedAt: start,
      attrs: { "brain.billing_mode": "api", "gen_ai.usage.per_model": { fixture: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, other: { inputTokens: 0, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } } } });
    f.activity.startSpan({ spanId: "child", parentSpanId: "multi", runId: "run-odysseus", name: "fixture", kind: "subagent", origin: "autonomous" });
    f.activity.endSpan("child", { outcome: "success", usage: { inputTokens: 9999 } });
    f.activity.endSpan("multi", { outcome: "success" }); f.activity.rollupRun("run-odysseus");
    expect(f.row("odysseus").observed_cost_usd).toBeNull();
    expect(f.row("odysseus").charged_cost_usd as number).toBeGreaterThanOrEqual(0.3);
    expect(f.row("odysseus").charged_cost_usd as number).toBeLessThan(0.300002);
    expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "choose")).toHaveLength(2);
  } finally { f.db.close(); }
});

test("runtime without admission plumbing refuses nonempty work before dispatch", async () => {
  const f = fixture(); let starts = 0;
  f.seed("odysseus");
  const runtime = createInboxRuntime(f.db, { log: { emit() {}, enabled: () => false }, dispatch: async () => { starts++; } });
  try {
    expect(await runtime.tick()).toMatchObject({ claimed: 0, dispatchEnabled: false });
    expect(starts).toBe(0);
    expect(f.store.getItem("odysseus")).toMatchObject({ status: "ready", attempts: 0 });
  } finally { await runtime.close(); f.db.close(); }
});

test("two processes race over-cap claims; one actual start and one FYI survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-budget-process-")), path = join(dir, "ui.db"), db = createUiDb(path);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const worker = join(import.meta.dir, "fixtures/inbox-runtime-worker.ts");
  const gate = join(dir, "gate"), s = createInboxStore(db, { now: () => start });
  for (const id of ["odysseus", "penelope"]) s.ingest({ threadId: id, itemId: id, dedupKey: id, stagingId: id, source: "share", stakes: 2, expiresAt: start + 86_400_000 });
  async function spawn(name: string) {
    const ready = join(dir, name);
    const child = Bun.spawn([process.execPath, worker, "budget", path, ready, gate, String(start)], { stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    return child;
  }
  try {
    const [a, b] = await Promise.all([spawn("a"), spawn("b")]);
    writeFileSync(gate, "go");
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    const outputs = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    const starts = outputs.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(starts).toHaveLength(1);
    expect(s.snapshot().items.filter((item) => item.queue === "queue" && item.status === "claimed")).toHaveLength(1);
    expect(s.snapshot().items.filter((item) => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
    const again = await spawn("restarted");
    expect(await again.exited).toBe(0);
    expect(await new Response(again.stdout).text()).toBe("");
    expect(s.snapshot().items.filter((item) => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});


test("partial API usage retains a larger known spend instead of reducing it to the reservation", () => {
  const f = fixture();
  try {
    f.claim("odysseus"); f.receipt("odysseus", { inputTokens: 2000 });
    expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 6 });
    expect(f.claim("penelope")).toBeNull();
  } finally { f.db.close(); }
});

test("unknown billing with complete zero usage is still unknown rather than free", () => {
  const f = fixture();
  try {
    f.claim("odysseus", { billingMode: "subscription" });
    f.receipt("odysseus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, "subscription", true, "unknown");
    expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 3 });
    expect(f.budget.totals().unpricedRuns).toBe(1);
  } finally { f.db.close(); }
});

test("separate compaction on a claimed item consumes another operation without another attempt", () => {
  const f = fixture({ spendUsd: 6, turns: 2 });
  try {
    f.claim("odysseus");
    expect(f.budget.reserve("odysseus", f.operation("compaction", { purpose: "compaction" }))).not.toBeNull();
    acquireInboxBudgetRun(f.db, "compaction", "owner", start);
    expect(f.store.getItem("odysseus")).toMatchObject({ status: "claimed", attempts: 1 });
    expect(f.budget.totals().normal).toEqual({ cost: 6_000_000, turns: 2 });
    expect(f.budget.reserve("odysseus", f.operation("another"))).toBeNull();
  } finally { f.db.close(); }
});

test("admission pricing route is frozen even when pricing changes before settlement", () => {
  const f = fixture();
  try {
    const routes: unknown[] = [];
    let current: PricingRates | null = rates;
    const pricing = { resolve: (_model: string, route?: PricingRoute) => { routes.push(route); return current; } };
    const budget = createInboxBudget(f.db, { config: f.config, pricing, now: () => start });
    f.seed("odysseus");
    expect(budget.claim("odysseus", f.operation("run-odysseus", { pricingRoute: "direct" }), start + 600_000)).not.toBeNull();
    expect(routes).toEqual(["direct"]);
    current = null;
    const activity = createActivityStore(f.db, { pricing });
    activity.startSpan({ spanId: "priced", runId: "run-odysseus", name: "fixture", kind: "turn", origin: "autonomous", startedAt: start,
      attrs: { "brain.billing_mode": "api", "gen_ai.usage.per_model": { fixture: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } } });
    activity.endSpan("priced", { outcome: "success" }); activity.rollupRun("run-odysseus");
    expect(f.row("odysseus").charged_cost_usd).toBe(0.3);
    expect(JSON.parse(f.row("odysseus").pricing_json as string).route).toBe("direct");
  } finally { f.db.close(); }
});

test("budget migration preserves populated reservations and recovery retains legacy charges", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-budget-migration-")), path = join(dir, "ui.db");
  let db = new Database(path);
  try {
    const migrations = join(import.meta.dir, "../migrations");
    db.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)");
    for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql") && file < "024_inbox_budget.sql").sort()) {
      db.exec(readFileSync(join(migrations, file), "utf8"));
      db.query("INSERT INTO _migrations (filename, applied_at) VALUES (?, 1)").run(file);
    }
    const s = createInboxStore(db, { now: () => start });
    s.ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus", stagingId: "odysseus", source: "share", stakes: 2, expiresAt: start + 86_400_000 });
    s.commit([{ kind: "transition", itemId: "odysseus", expectedVersion: 1, to: "claimed", leaseUntil: start + 1 },
      { kind: "reserve", reservation: { id: "legacy", operationKey: "legacy", itemId: "odysseus", attempt: 1, purpose: "execute", runId: "legacy", principalId: "owner", model: "fixture", billingMode: "api", localDay: "2026-10-01", reserveKind: "normal", reservedCostUsd: 3, reservedTurns: 1 } }]);
    const before = db.query("SELECT * FROM inbox_budget_reservations").get() as Record<string, unknown>;
    expect(before.reserved_cost_usd).toBe(3);
    db.close(); db = createUiDb(path);
    expect(db.query("SELECT * FROM inbox_budget_reservations").get()).toEqual({ ...before, pricing_json: null, runtime_acquired_at: null, observed_billing_mode: null });
    const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 10, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => rates }, now: () => start + 1 });
    expect(budget.recover()).toBe(1);
    expect(db.query("SELECT status, charged_cost_usd, charged_turns FROM inbox_budget_reservations").get()).toEqual({ status: "released", charged_cost_usd: 3, charged_turns: 1 });
    db.close(); db = createUiDb(path);
    expect(db.query("SELECT COUNT(*) AS n FROM _migrations WHERE filename = '024_inbox_budget.sql'").get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("a missing cache rate is pessimistic and visible in active and settled totals", () => {
  const f = fixture({}, { ...rates, cacheRead: null });
  try {
    expect(f.claim("odysseus", { maximumTokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, cacheCreationTokens: 0 } })).not.toBeNull();
    expect(f.budget.totals()).toMatchObject({ normal: { cost: 1_000_000, turns: 1 }, unpricedRuns: 1 });
    f.receipt("odysseus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 20, cacheCreationTokens: 0 });
    expect(f.row("odysseus")).toMatchObject({ observed_cost_usd: null, charged_cost_usd: 0.2 });
    expect(f.budget.totals().unpricedRuns).toBe(1);
    expect(f.store.snapshot().items.filter((item) => item.queue === "actions" && item.type === "choose")).toHaveLength(1);
  } finally { f.db.close(); }
});

test("removing dropped work cannot make its reservation disappear or break recovery", () => {
  const f = fixture({}, null);
  try {
    f.claim("odysseus", { maximumTokens: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    f.store.commit([{ kind: "transition", itemId: "odysseus", expectedVersion: 2, to: "dropped" },
      { kind: "remove_item", itemId: "odysseus", expectedVersion: 3 }]);
    let recovered = 0;
    expect(() => { recovered = f.budget.recover(); }).not.toThrow();
    expect(recovered).toBe(1);
    expect(f.row("odysseus")).toMatchObject({ status: "released", charged_cost_usd: 1, charged_turns: 1 });
    expect(f.budget.totals()).toMatchObject({ normal: { cost: 1_000_000, turns: 1 }, unpricedRuns: 1 });
  } finally { f.db.close(); }
});
