import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createTurnBudgets, BudgetExceeded } from "../src/brain/turn-budgets.js";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
const policy = () => resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 10 }, session: { warn_usd: 3, block_usd: 4, block_tokens: 20 }, day: { warn_usd: 3, block_usd: 4, block_tokens: 20 } } });
function fixture() {
  const db = createUiDb(":memory:");
  let now = Date.UTC(2026, 6, 12, 23, 59);
  const budgets = createTurnBudgets(db, { resolve: model => model === "odysseus" ? { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" } : null }, () => now);
  return { db, budgets, tick(ms: number) { now += ms; }, close() { db.close(); } };
}
const usage = (n: number, model = "odysseus") => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { [model]: { inputTokens: n } } });
test("list-price completed usage warns once; resumed terminal totals and subscription effective zero cannot change it", () => {
  const f = fixture();
  try {
    f.budgets.begin("athena", "ithaca", policy());
    expect(f.budgets.observe("athena", usage(1))!.warnings.map(w => w.scope)).toEqual(["turn"]);
    expect(f.budgets.observe("athena", usage(1))!.warnings).toEqual([]);
    expect(f.budgets.observe("athena", usage(2))!.blocked?.scope).toBe("turn");
    f.db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,effective_cost_usd,input_tokens) VALUES('athena','session','invoke_agent','ithaca',?,200,0,200)").run(Date.UTC(2026, 6, 12));
    expect(f.budgets.receipt("athena").scopes.find(s => s.scope === 'session')!.costUsd).toBe(2);
  }
  finally {
    f.close();
  }
});
test("unpriced usage remains unknown and token fallback blocks without inventing zero", () => {
  const f = fixture();
  try {
    f.budgets.begin("athena", "ithaca", policy());
    const first = f.budgets.observe("athena", usage(9, "unknown"))!;
    expect(first.receipt.listPriceCostUsd).toBeNull();
    expect(first.blocked).toBeUndefined();
    expect(f.budgets.observe("athena", usage(10, "unknown"))!.blocked?.scope).toBe("turn");
  }
  finally {
    f.close();
  }
});
test("retained root Activity list prices block session/day admission and live sessions share day totals", () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,effective_cost_usd,input_tokens) VALUES('old','session','invoke_agent','ithaca',?,4,0,4)").run(Date.UTC(2026, 6, 12));
    expect(() => f.budgets.begin("new", "ithaca", policy())).toThrow(BudgetExceeded);
    f.tick(120000);
    expect(() => f.budgets.begin("next", "other", policy())).not.toThrow();
    f.budgets.observe("next", usage(2));
    f.budgets.begin("peer", "third", policy());
    f.budgets.observe("peer", usage(2));
    expect(() => f.budgets.begin("later", "fourth", policy())).toThrow(BudgetExceeded);
    expect(f.budgets.receipt("peer").scopes.find(s => s.scope === 'day')!.resetAt).toBe(Date.UTC(2026, 6, 14));
  }
  finally {
    f.close();
  }
});
test("UTC response slices do not recharge yesterday's cumulative usage and survive host restart", () => {
  const f = fixture();
  try {
    f.budgets.begin("athena", "ithaca", policy());
    f.budgets.observe("athena", usage(1));
    f.tick(120000);
    f.budgets.observe("athena", usage(2));
    expect(f.budgets.receipt("athena").scopes.find(s => s.scope === 'day')!.costUsd).toBe(1);
    const restarted = createTurnBudgets(f.db, { resolve: () => null }, () => Date.UTC(2026, 6, 13, 0, 1));
    restarted.begin("later", "ithaca", policy());
    expect(restarted.receipt("later").scopes.find(s => s.scope === 'session')!.costUsd).toBe(2);
    expect(restarted.receipt("later").scopes.find(s => s.scope === 'day')!.costUsd).toBe(1);
  }
  finally {
    f.close();
  }
});
test("the shared Activity calculator uses the admitted pricing route and frozen per-model rates for all token classes", () => {
  const db = createUiDb(":memory:");
  let inputRate = 0.01;
  const routes: Array<string | undefined> = [];
  const budgets = createTurnBudgets(db, { resolve: (_model, route) => { routes.push(route); return { input: route === "openrouter" ? inputRate : 10, output: 0.1, cacheRead: 0.001, cacheWrite: 0.02, estimate: false, source: "snapshot" }; } });
  try {
    budgets.begin("athena", "ithaca", policy(), "openrouter");
    const sample = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5, perModel: { odysseus: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5 } } };
    expect(budgets.observe("athena", sample)!.receipt.listPriceCostUsd, "BUDGET_ACTIVITY_CATALOG_AND_FOUR_CLASSES").toBeCloseTo(0.5);
    inputRate = 100;
    expect(budgets.observe("athena", sample)!.blocked).toBeUndefined();
    expect(routes).toEqual(["openrouter"]);
  }
  finally {
    db.close();
  }
});
test("adding unpriced inference cannot erase a priced lower bound, warning or stop", () => {
  const f = fixture();
  try {
    f.budgets.begin("athena", "ithaca", policy());
    f.budgets.observe("athena", usage(1));
    const mixed = (n: number) => ({ inputTokens: n + 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { odysseus: { inputTokens: n }, unknown: { inputTokens: 1 } } });
    const first = f.budgets.observe("athena", mixed(1))!;
    expect(first.receipt.listPriceCostUsd).toBeNull();
    expect(first.receipt.scopes[0]).toMatchObject({ costUsd: 1, unknownRuns: 1, warning: true, blocked: false });
    expect(f.budgets.observe("athena", mixed(2))!.blocked).toMatchObject({ scope: "turn", costUsd: 2 });
  }
  finally {
    f.close();
  }
});
test("retained warning evidence is disclosed once at admission, without inventing a response", () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,input_tokens) VALUES('retained','session','invoke_agent','ithaca',?,3,3)").run(Date.UTC(2026, 6, 12));
    f.budgets.begin("athena", "ithaca", policy());
    expect(f.budgets.warnings("athena").map(item => item.scope)).toEqual(["session", "day"]);
    expect(f.budgets.warnings("athena")).toEqual([]);
    expect(f.budgets.saved("athena")?.listPriceCostUsd).toBeNull();
  }
  finally {
    f.close();
  }
});
