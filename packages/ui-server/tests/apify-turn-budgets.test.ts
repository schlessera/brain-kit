/**
 * Admitted Apify liability in the global inference turn budgets (#3307): the
 * shared ledger's turn, session and brain-day liability counts once, as USD,
 * in admission, mid-turn blocks and the receipt; Apify admission reads
 * inference without it; and an unreadable ledger is unavailable, never zero.
 * The ledger is a real private file; the voyage is fictional.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { turnBudgetReceiptSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import {
  BudgetExceeded, createTurnBudgets, inferenceBudgetLimits, TURN_BUDGET_APIFY_COVERAGE, TURN_BUDGET_APIFY_UNAVAILABLE_COVERAGE, TURN_BUDGET_COVERAGE,
  type ApifyBudgetLiability, type ApifyBudgetSource,
} from "../src/brain/turn-budgets.js";
import { apifyBudgetSource } from "../src/apify/budget-liability.js";
import { openApifyLedger, type ApifyReservation } from "@schlessera/brain-common/internal/apify";
import { expectRejection } from "./helpers/expect-rejection.js";

const policy = () => resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 10 },
  session: { warn_usd: 3, block_usd: 4, block_tokens: 20 }, day: { warn_usd: 3, block_usd: 4, block_tokens: 20 } } });
// One dollar per token, so token counts read as dollars.
const pricing = { resolve: (model: string) => model === "odysseus" ? { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const } : null };
const usage = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { odysseus: { inputTokens: n } } });

let root: string;
let now: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "apify-turn-budgets-odysseus-")); now = Date.UTC(2026, 6, 12, 9); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A fixed liability, with every read recorded. */
function stub(liability: ApifyBudgetLiability | (() => ApifyBudgetLiability)) {
  const reads: Array<{ turn_id: string | null; session_id: string | null }> = [];
  const source: ApifyBudgetSource = scope => { reads.push(scope); return typeof liability === "function" ? liability() : liability; };
  return { source, reads };
}
function fixture(apify?: ApifyBudgetSource) {
  const db = createUiDb(":memory:");
  return { db, budgets: createTurnBudgets(db, pricing, () => now, undefined, apify), close() { db.close(); } };
}

const reservation = (turn_id: string, session_id: string, digest: string, cap = 1_000_000): ApifyReservation => ({
  account_id: "IthacaHousehold01", generation: "g1", brain_id: "ithaca-brain", principal_id: "penelope", session_id, turn_id, proposal_digest: digest,
  actor_id: "SeaCharts01", build_id: "SeaBuild142", build_number: "1.4.2", profile_id: "sea-charts", input_sha256: "0".repeat(64),
  run_cap_micro: cap, request_micro: 0, storage_micro: 0, request_unit_micro: 0, deadline_at: now + 60_000, retention_seconds: 3600,
  timeout_secs: 60, memory_mbytes: 1024, items_bound: 10, max_result_items: 10, max_result_bytes: 10_000, status_budget: 1, result_budget: 1, abort_budget: 1,
});
const wide = { run_micro: 10e6, turn_micro: 10e6, session_micro: 10e6, day_micro: 10e6, brain_day_micro: 10e6, max_runs_per_turn: 5, max_concurrent_runs: 5 };

test("Apify day liability plus inference blocks admission exactly as inference alone would", async () => {
  // Inference alone: $2 earlier today leaves room for a new turn.
  const plain = fixture();
  try {
    await plain.budgets.begin("calypso", "ogygia", policy());
    await plain.budgets.observe("calypso", usage(2));
    await plain.budgets.begin("aeolus", "winds", policy());
  } finally { plain.close(); }
  // The same $2 of inference with $2 of Apify liability on this brain's day reaches the $4 day stop.
  const f = fixture(stub({ turn_usd: 0, session_usd: 0, day_usd: 2 }).source);
  try {
    await f.budgets.begin("calypso", "ogygia", policy());
    await f.budgets.observe("calypso", usage(2));
    const error = await expectRejection(f.budgets.begin("aeolus", "winds", policy()), BudgetExceeded, "APIFY_LIABILITY_BLOCKS_ADMISSION") as BudgetExceeded;
    expect(error.stage).toBe("admission");
    expect(error.observation.scope).toBe("day");
    expect(error.observation.costUsd, "APIFY_DAY_COUNTED_ONCE").toBe(4);
    expect(error.observation.apifyUsd).toBe(2);
    expect(error.message).toContain("including $2 admitted Apify liability");
  } finally { f.close(); }
});

test("Apify turn liability plus inference blocks mid-turn exactly as inference alone would", async () => {
  const liability = { turn_usd: 0, session_usd: 0, day_usd: 0 };
  const { source } = stub(() => liability);
  const f = fixture(source);
  try {
    await f.budgets.begin("polyphemus", "cyclops-cave", policy());
    expect((await f.budgets.observe("polyphemus", usage(1)))!.blocked, "INFERENCE_ALONE_UNDER_STOP").toBeUndefined();
    // A run admitted mid-turn holds $1.5 of the turn; the next completed response sees it.
    Object.assign(liability, { turn_usd: 1.5, session_usd: 1.5, day_usd: 1.5 });
    const result = (await f.budgets.observe("polyphemus", usage(1)))!;
    expect(result.blocked?.scope, "APIFY_LIABILITY_BLOCKS_MID_TURN").toBe("turn");
    expect(result.blocked!.costUsd).toBe(2.5);
    expect(result.receipt.listPriceCostUsd, "OWN_INFERENCE_STAYS_SEPARATE").toBe(1);
    // The SDK backstop shrinks by the same liability.
    expect(f.budgets.remaining("polyphemus")).toBe(0);
    // The relay refuses the next CLI provider request on the same block.
    expect((await f.budgets.providerAdmission("polyphemus", policy()))?.scope).toBe("turn");
  } finally { f.close(); }
});

test("Apify liability counts once per scope, and Apify admission reads inference without it", async () => {
  const f = fixture(stub({ turn_usd: 0.25, session_usd: 0.5, day_usd: 0.75 }).source);
  try {
    await f.budgets.begin("scylla", "strait", policy());
    const result = (await f.budgets.observe("scylla", usage(1)))!;
    expect(result.receipt.scopes.map(scope => [scope.scope, scope.costUsd, scope.apifyUsd]), "APIFY_COUNTED_ONCE_PER_SCOPE")
      .toEqual([["turn", 1.25, 0.25], ["session", 1.5, 0.5], ["day", 1.75, 0.75]]);
    // Re-reading the receipt reads the ledger again; it never adds a second time.
    expect(f.budgets.receipt("scylla").scopes.map(scope => scope.costUsd)).toEqual([1.25, 1.5, 1.75]);
    // Apify admission subtracts inference from the global budget and its own liability from its ledger.
    expect(await f.budgets.inferenceSpend({ session_id: "strait", turn_id: "scylla" }), "INFERENCE_SPEND_EXCLUDES_APIFY")
      .toEqual({ turn_usd: 1, session_usd: 1, day_usd: 1 });
    await expectRejection(f.budgets.inferenceSpend({ session_id: "strait", turn_id: "charybdis" }), "Turn has no frozen budget admission");
  } finally { f.close(); }
});

test("the shared ledger's turn, session and brain-day liability reach the receipt once", async () => {
  const ledger = openApifyLedger(join(root, "apify", "ledger.sqlite"));
  try {
    ledger.reserve(reservation("sirens", "aeaea", "d1", 1_000_000), wide, now, 32);
    ledger.reserve(reservation("circe", "aeaea", "d2", 500_000), wide, now, 32);
    ledger.reserve(reservation("lotus", "djerba", "d3", 250_000), wide, now, 32);
    // Another brain on the same account: its own global budgets, not this one's.
    ledger.reserve({ ...reservation("helios", "thrinacia", "d4", 2_000_000), brain_id: "other-brain" }, wide, now, 32);
    const f = fixture(apifyBudgetSource(() => ledger, "ithaca-brain"));
    try {
      const receipt = await f.budgets.begin("sirens", "aeaea", policy());
      expect(receipt.coverage, "COVERAGE_NAMES_APIFY_WHEN_WIRED").toBe(TURN_BUDGET_APIFY_COVERAGE);
      expect(receipt.scopes.map(scope => [scope.scope, scope.apifyUsd, scope.costUsd]), "LEDGER_SCOPES_IN_RECEIPT")
        .toEqual([["turn", 1, 1], ["session", 1.5, 1.5], ["day", 1.75, 1.75]]);
      expect(turnBudgetReceiptSchema.safeParse(receipt).success, "RECEIPT_MATCHES_PROTOCOL").toBe(true);
    } finally { f.close(); }
  } finally { ledger.close(); }
});

test("the reading crosses to the write worker with the turn's bound session", async () => {
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const { source, reads } = stub({ turn_usd: 1, session_usd: 1, day_usd: 1 });
  const budgets = createTurnBudgets(db, pricing, () => now, writer, source);
  try {
    expect(writer.offloop).toBe(true);
    await budgets.begin("argos", undefined, policy());
    await budgets.bind("argos", "ithaca-hall");
    const result = (await budgets.observe("argos", usage(1)))!;
    expect(result.blocked?.scope, "WORKER_RECEIPT_COUNTS_APIFY").toBe("turn");
    expect(budgets.saved("argos")!.coverage).toBe(TURN_BUDGET_APIFY_COVERAGE);
    expect(reads, "READS_USE_THE_BUDGET_IDENTITIES").toEqual([{ turn_id: "argos", session_id: null }, { turn_id: "argos", session_id: "ithaca-hall" }]);
  } finally { await writer.close(); db.close(); }
});

test("without a wired ledger the receipt and limits text stay unchanged", async () => {
  const f = fixture();
  try {
    const receipt = await f.budgets.begin("penelope", "loom", policy());
    expect(receipt.coverage, "COVERAGE_UNCHANGED_WITHOUT_LEDGER").toBe(TURN_BUDGET_COVERAGE);
    expect(receipt.scopes.filter(scope => "apifyUsd" in scope)).toEqual([]);
    expect(inferenceBudgetLimits(receipt)).toContain("; Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered)");
  } finally { f.close(); }
});

test("an unreadable ledger keeps inference's behaviour and reports Apify as unavailable, never zero", async () => {
  for (const failing of [() => { throw new Error("ledger locked"); }, () => ({ turn_usd: Number.NaN, session_usd: 0, day_usd: 0 })] as const) {
    const f = fixture(failing as ApifyBudgetSource);
    try {
      const receipt = await f.budgets.begin("eurylochus", "thrinacia", policy());
      expect(receipt.coverage, "COVERAGE_SAYS_APIFY_UNAVAILABLE").toBe(TURN_BUDGET_APIFY_UNAVAILABLE_COVERAGE);
      expect(receipt.scopes.filter(scope => "apifyUsd" in scope), "UNAVAILABLE_IS_NOT_ZERO").toEqual([]);
      expect(turnBudgetReceiptSchema.safeParse(receipt).success).toBe(true);
      // Inference alone still blocks where it always did, and only there.
      expect((await f.budgets.observe("eurylochus", usage(1)))!.blocked).toBeUndefined();
      expect((await f.budgets.observe("eurylochus", usage(2)))!.blocked?.scope, "INFERENCE_BLOCK_UNCHANGED").toBe("turn");
      expect(f.budgets.receipt("eurylochus").scopes[0]!.costUsd).toBe(2);
    } finally { f.close(); }
  }
  // A ledger that cannot be opened is the same: its directory is a plain file.
  writeFileSync(join(root, "wreck"), "");
  const f = fixture(apifyBudgetSource(() => openApifyLedger(join(root, "wreck", "ledger.sqlite")), "ithaca-brain"));
  try { expect((await f.budgets.begin("elpenor", "aeaea", policy())).coverage).toBe(TURN_BUDGET_APIFY_UNAVAILABLE_COVERAGE); }
  finally { f.close(); }
});

test("outside a turn the day scope still counts this brain's Apify liability", async () => {
  const f = fixture(stub({ turn_usd: 9, session_usd: 9, day_usd: 4 }).source);
  try {
    const day = await f.budgets.providerAdmission(null, policy());
    expect(day?.scope, "MAINTENANCE_DAY_COUNTS_APIFY").toBe("day");
    expect(day!.costUsd).toBe(4);
  } finally { f.close(); }
});
