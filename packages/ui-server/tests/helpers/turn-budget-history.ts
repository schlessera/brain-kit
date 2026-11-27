/**
 * A budget history in which every receipt scope has something to select
 * (#4799): a legacy rollup-only turn, a turn with both a rollup and a usage
 * row, a turn whose responses fall on both sides of a UTC midnight, a second
 * session on the same day, a turn with no session, relayed provider attempts
 * and a compute reservation. Three same-day turns cost 0.1, 0.2 and 0.3,
 * which do not sum associatively in floating point, so any change in the
 * order rows reach a total changes the receipt.
 */
import type { Database } from "bun:sqlite";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { budgetLedger } from "../../src/brain/turn-budgets.js";

export const HOUR = 3_600_000;
/** The pinned example day, 2026-07-12 UTC, and the day before it. */
export const DAY_START = Date.UTC(2026, 6, 12), PREVIOUS_DAY = DAY_START - 24 * HOUR;
/** When the fixture's receipts are read. */
export const READ_AT = DAY_START + 5 * HOUR;

export const budgetPolicy = () => resolveGovernancePolicy({ schema_version: 1, budgets: {
  turn: { warn_usd: 50, block_usd: 100, block_tokens: 1_000_000 },
  session: { warn_usd: 50, block_usd: 100, block_tokens: 1_000_000 },
  day: { warn_usd: 50, block_usd: 100, block_tokens: 1_000_000 },
} });

const measured = (cost: number | null, tokens: number | null) => ({ cost, tokens, estimate: cost === null ? null : 0, partialCost: null });

/** Writes the history into a migrated database; returns the turns whose receipts it is read for. */
export function seedBudgetHistory(db: Database): string[] {
  const ledger = budgetLedger(db), policy = budgetPolicy();
  const rollup = db.query(`INSERT INTO activity_run_rollups(run_id,origin,name,session_id,started_at,cost_usd,input_tokens,output_tokens)
    VALUES(?,?,?,?,?,?,?,?)`);
  // An unrelated turn three days earlier in another session: in no scope.
  ledger.begin("calypso", "ogygia", policy, PREVIOUS_DAY - 2 * 24 * HOUR);
  ledger.observe("calypso", policy, measured(1.5, 1500), PREVIOUS_DAY - 2 * 24 * HOUR + 60_000);
  // A legacy Activity rollup with no usage row, and rows the ledger never selects.
  rollup.run("argo", "session", "invoke_agent", "ithaca", DAY_START + HOUR, 0.25, 100, 25);
  rollup.run("argo-sub", "session", "subagent", "ithaca", DAY_START + HOUR, 9, 900, 0);
  rollup.run("loom-sweep", "job", "invoke_agent", null, DAY_START + HOUR, 9, 900, 0);
  // Responses on both sides of midnight: 0.7 yesterday, 0.2 today.
  ledger.begin("telemachus", "ithaca", policy, PREVIOUS_DAY + 23 * HOUR + 59 * 60_000);
  ledger.observe("telemachus", policy, measured(0.7, 700), PREVIOUS_DAY + 23 * HOUR + 59 * 60_000 + 30_000);
  ledger.observe("telemachus", policy, measured(0.9, 900), DAY_START + 60_000);
  // A turn with both a usage row and a (resumed, larger) terminal rollup.
  ledger.begin("penelope", "ithaca", policy, DAY_START + 2 * HOUR);
  ledger.observe("penelope", policy, measured(0.1, 10), DAY_START + 2 * HOUR + 60_000);
  rollup.run("penelope", "session", "invoke_agent", "ithaca", DAY_START + 2 * HOUR, 0.5, 50, 0);
  // A second session on the same day, with a priced and an unpriced relayed attempt.
  ledger.begin("nausicaa", "scheria", policy, DAY_START + 3 * HOUR);
  ledger.observe("nausicaa", policy, measured(0.2, 20), DAY_START + 3 * HOUR + 60_000);
  const attempt = db.query(`INSERT INTO provider_relay_usage(attempt_id,turn_id,day_start,observed_at,family,operation,origin,model,outcome,status,usage,cost_usd,pricing_estimate,tokens)
    VALUES(?,?,?,?,'openai','responses','https://api.openai.example','gpt-example','completed',200,NULL,?,?,?)`);
  attempt.run("attempt-1", "nausicaa", DAY_START, DAY_START + 3 * HOUR + 120_000, 0.05, 0, 40);
  attempt.run("attempt-2", "nausicaa", DAY_START, DAY_START + 3 * HOUR + 180_000, null, null, 30);
  // A maintenance attempt that belongs to no turn.
  attempt.run("attempt-3", null, DAY_START, DAY_START + 4 * HOUR + 30 * 60_000, 0.01, 0, 5);
  // A turn with no session, and one that is unpriced.
  ledger.begin("eumaeus", null, policy, DAY_START + 4 * HOUR);
  ledger.observe("eumaeus", policy, measured(0.3, 30), DAY_START + 4 * HOUR + 60_000);
  ledger.begin("argus", "ithaca", policy, DAY_START + 4 * HOUR + 10 * 60_000);
  ledger.observe("argus", policy, measured(null, 60), DAY_START + 4 * HOUR + 11 * 60_000);
  // A settled and an active compute reservation.
  ledger.reserveCompute("loom-1", "penelope", "ithaca", 0.4, policy, DAY_START + 2 * HOUR + 30 * 60_000);
  ledger.settleCompute("loom-1", 0.35, DAY_START + 2 * HOUR + 45 * 60_000);
  ledger.reserveCompute("loom-2", "nausicaa", "scheria", 0.6, policy, DAY_START + 3 * HOUR + 30 * 60_000);
  return ["calypso", "telemachus", "penelope", "nausicaa", "eumaeus", "argus"];
}

/** Every receipt and the day observation, as the golden compares them. */
export function readBudgetHistory(db: Database, turns: string[]) {
  const ledger = budgetLedger(db), policy = budgetPolicy();
  return {
    receipts: Object.fromEntries(turns.map(id => [id, ledger.receipt(id, policy, READ_AT, null)])),
    apify: ledger.receipt("penelope", policy, READ_AT, { turn_usd: 0.01, session_usd: 0.02, day_usd: 0.03 }),
    day: ledger.dayObservation(policy, READ_AT, null),
  };
}
