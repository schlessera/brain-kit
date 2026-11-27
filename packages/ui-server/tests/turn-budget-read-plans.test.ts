/** The budget receipt reads one turn's, one session's and one day's rows through indexes (#4799). */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createUiDb } from "../src/db/client.js";
import { budgetLedger } from "../src/brain/turn-budgets.js";
import { budgetPolicy, DAY_START, HOUR, PREVIOUS_DAY, READ_AT, readBudgetHistory, seedBudgetHistory } from "./helpers/turn-budget-history.js";
import { queryPlan, recordStatements } from "./helpers/statement-recorder.js";

const BUDGET_TABLES = ["activity_run_rollups", "turn_budget_usage", "turn_budget_days"];
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/turn-budget-history.golden.json", import.meta.url), "utf8"));

/** History in other sessions on other days, which no scope of today's receipt selects. */
function seedUnrelated(db: Database, turns: number) {
  const usage = db.query("INSERT INTO turn_budget_usage(turn_id,session_id,started_at,cost_usd,cost_lower_bound,pricing_estimate,tokens,observed_at) VALUES(?,?,?,0.01,0.01,0,10,?)");
  const days = db.query("INSERT INTO turn_budget_days(turn_id,day_start,cost_usd,cost_lower_bound,tokens) VALUES(?,?,0.01,0.01,10)");
  const rollup = db.query("INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,input_tokens) VALUES(?,'session','invoke_agent',?,?,0.01,10)");
  db.transaction(() => {
    for (let i = 0; i < turns; i++) {
      const day = PREVIOUS_DAY - (1 + i % 300) * 24 * HOUR, started = day + HOUR;
      usage.run(`voyage-${i}`, `aeaea-${i % 50}`, started, started);
      days.run(`voyage-${i}`, day);
      rollup.run(`legacy-voyage-${i}`, `aeaea-${i % 50}`, started);
    }
  })();
}

test("every receipt and day observation matches the receipts captured before the indexed reads (#4799)", () => {
  const db = createUiDb(":memory:");
  try {
    expect(readBudgetHistory(db, seedBudgetHistory(db))).toEqual(GOLDEN);
  } finally { db.close(); }
});

test("every budget read of a receipt and a day observation searches an index, never scans a budget table (#4799)", () => {
  const db = createUiDb(":memory:");
  try {
    seedBudgetHistory(db);
    seedUnrelated(db, 20);
    const recorded = recordStatements(db), ledger = budgetLedger(recorded.db), policy = budgetPolicy();
    for (const id of ["telemachus", "eumaeus"]) ledger.receipt(id, policy, READ_AT, null);
    ledger.dayObservation(policy, READ_AT, null);
    const reads = [...new Map(recorded.statements.filter(s => /^\s*SELECT/i.test(s.sql)).map(s => [s.sql, s])).values()];
    expect(reads.length).toBeGreaterThanOrEqual(5);
    const steps = reads.flatMap(read => queryPlan(db, read).map(step => ({ sql: read.sql.replace(/\s+/g, " ").slice(0, 80), step })))
      .filter(({ step }) => BUDGET_TABLES.some(table => new RegExp(`\\b${table}\\b`).test(step)));
    // The day's turn ids, the session's rows and the day's per-turn totals each have their own index.
    expect(steps.some(({ step }) => step.includes("turn_budget_days_day (day_start=?)"))).toBe(true);
    expect(steps.some(({ step }) => step.includes("idx_activity_rollups_session (session_id=?)"))).toBe(true);
    expect(steps.some(({ step }) => step.includes("turn_budget_usage_started (started_at>? AND started_at<?)"))).toBe(true);
    expect(steps.filter(({ step }) => !/^SEARCH \w+ USING (COVERING )?INDEX /.test(step))).toEqual([]);
  } finally { db.close(); }
});

test("one completed response runs the same statements however much unrelated history the host holds (#4799)", () => {
  const count = (unrelated: number, sameDay: number) => {
    const db = createUiDb(":memory:");
    try {
      seedUnrelated(db, unrelated);
      const ledger = budgetLedger(db), policy = budgetPolicy();
      for (let i = 0; i < sameDay; i++) {
        ledger.begin(`suitor-${i}`, `suitors-${i}`, policy, DAY_START + HOUR + i * 60_000);
        ledger.observe(`suitor-${i}`, policy, { cost: 0.1, tokens: 10, estimate: 0, partialCost: null }, DAY_START + HOUR + i * 60_000 + 1_000);
      }
      ledger.begin("odysseus", "ithaca", policy, DAY_START + 2 * HOUR);
      const recorded = recordStatements(db);
      budgetLedger(recorded.db).observe("odysseus", policy, { cost: 0.2, tokens: 20, estimate: 0, partialCost: null }, DAY_START + 2 * HOUR + 60_000);
      return recorded.statements.length;
    } finally { db.close(); }
  };
  const small = count(10, 1);
  expect(small).toBeGreaterThan(0);
  expect(count(1_000, 6)).toBe(small);
});
