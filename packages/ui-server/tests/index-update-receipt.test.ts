import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexBatch, IndexFlushError } from "../src/brain/index-batch.js";
import type { IndexUpdateReceipt } from "../src/brain/index-update-receipt.js";
import { reserveMaintenanceTemp } from "../../ui-sdk/src/server/maintenance-temp-budget.js";

test("one receipt per index update carries generation, duration and outcome for every causing turn", async () => {
  const receipts: { receipt: IndexUpdateReceipt; turns: string[] }[] = [];
  let failure: Error | undefined;
  const batch = createIndexBatch({ async index() { if (failure) throw failure; }, receipt: (receipt, turns) => receipts.push({ receipt, turns }) });
  batch.queue(["notes/ithaca.md"], undefined, "voyage"); batch.queue(["notes/scheria.md"], undefined, "return");
  await batch.barrier();
  failure = new Error("index writer failed"); batch.queue(["notes/ithaca.md"], undefined, "voyage");
  expect(await batch.barrier().then(() => null, error => error)).toBeInstanceOf(IndexFlushError);
  failure = undefined; await batch.barrier();
  expect(receipts.map(entry => [entry.receipt.outcome, entry.turns]), "ONE_INDEX_RECEIPT_PER_UPDATE").toEqual([["complete", ["voyage", "return"]], ["failed", ["voyage"]], ["complete", ["voyage"]]]);
  expect(receipts[1]?.receipt.cause).toBe("index writer failed");
  expect(new Set(receipts.map(entry => entry.receipt.generation)).size, "INDEX_GENERATIONS_UNIQUE").toBe(3);
  expect(receipts.map(entry => typeof entry.receipt.durationMs)).toEqual(["number", "number", "number"]);
  expect(receipts.filter(entry => entry.receipt.durationMs < 0)).toEqual([]);
});

test("index update hits its separate maintenance storage bound with index_capacity and retries after room is freed", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-bound-"));
  const limits = { allowanceBytes: 4096, budgetBytes: 4096 };
  const domain = { statePath: join(root, "ui.db") };
  const held = reserveMaintenanceTemp(limits, domain, "index");
  const receipts: IndexUpdateReceipt[] = [];
  let ran = 0;
  const batch = createIndexBatch({ async index() { const reservation = reserveMaintenanceTemp(limits, domain, "index"); try { ran++; } finally { reservation.release(); } }, receipt: receipt => receipts.push(receipt) });
  try {
    batch.queue(["notes/ithaca.md"], undefined, "voyage");
    expect(await batch.barrier().then(() => null, error => error)).toBeInstanceOf(IndexFlushError);
    expect(ran, "INDEX_BOUND_REFUSES_BEFORE_WRITER_RUNS").toBe(0);
    expect(receipts.map(receipt => receipt.outcome), "INDEX_BOUND_HAS_NAMED_RESULT").toEqual(["index_capacity"]);
    expect(batch.pending()).toBe(true);
    held.release(); await batch.barrier();
    expect(ran).toBe(1); expect(batch.pending()).toBe(false);
    expect(receipts.map(receipt => receipt.outcome)).toEqual(["index_capacity", "complete"]);
  } finally { held.release(); await batch.idle(); rmSync(root, { recursive: true, force: true }); }
});

test("shutdown cancellation is recorded before the credentialed refresh suppresses it", async () => {
  const { credentialedIndexRefresh } = await import("../src/brain/credentialed-index-refresh.js");
  const closing = new AbortController(), shutdown = new Error("Server shutting down"), receipts: IndexUpdateReceipt[] = [], reported: unknown[] = [];
  const refresh = credentialedIndexRefresh({ async index() { closing.abort(shutdown); throw closing.signal.reason; }, cancellation: [closing.signal], receipt: receipt => receipts.push(receipt), report: error => reported.push(error) });
  refresh(["voyage"]); await refresh.idle();
  expect(receipts.map(receipt => receipt.outcome), "CANCELLED_INDEX_NEVER_REPORTED_COMPLETE").toEqual(["cancelled"]);
  expect(receipts[0]?.cause).toBe("Server shutting down"); expect(reported).toEqual([]);
});

test("each separate credentialed update keeps causing turns and its own failure receipt", async () => {
  const { credentialedIndexRefresh } = await import("../src/brain/credentialed-index-refresh.js");
  const receipts: { receipt: IndexUpdateReceipt; turns: string[] }[] = [], failures: unknown[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  const refresh = credentialedIndexRefresh({ async index() { if (++calls === 1) { entered.resolve(); await release.promise; throw new Error("vector indexing failed"); } },
    cancellation: [], receipt: (receipt, turns) => receipts.push({ receipt, turns }), report: error => failures.push(error) });
  const batch = createIndexBatch({ async index() {}, receipt: (receipt, turns) => receipts.push({ receipt, turns }), afterIndex: refresh });
  try {
    batch.queue(["notes/ithaca.md"], undefined, "voyage"); await batch.barrier(); await entered.promise;
    batch.queue(["notes/scheria.md"], undefined, "return"); batch.queue(["notes/athena.md"], undefined, "return"); await batch.barrier();
    release.resolve(); await refresh.idle();
    expect(receipts.map(entry => [entry.receipt.outcome, entry.turns]), "CREDENTIALED_UPDATE_HAS_SEPARATE_CORRELATED_RECEIPT").toEqual([["complete", ["voyage"]], ["complete", ["return"]], ["failed", ["voyage"]], ["complete", ["return"]]]);
    expect(new Set(receipts.map(entry => entry.receipt.generation)).size).toBe(4);
    expect(receipts[2]?.receipt.cause).toBe("vector indexing failed"); expect(failures).toHaveLength(1);
  } finally { release.resolve(); await batch.idle(); await refresh.idle(); }
});

test("governed post-turn refresh records shutdown cancellation before suppressing its warning", async () => {
  const { createGovernedTurns } = await import("../src/brain/governed-turn.js");
  const receipts: IndexUpdateReceipt[] = [], warnings: string[] = [], shutdown = new AbortController(), reason = new Error("Server shutting down");
  const turns = createGovernedTurns({ brainPath: "/odysseus", nativeManager: {} as never, execution: {} as never, profile: "governed", maskPaths: [],
    async index() { shutdown.abort(reason); throw reason; }, indexCancellation: [shutdown.signal], report: message => warnings.push(message), indexReceipt: receipt => receipts.push(receipt) });
  turns.refresh({} as never, "voyage"); await turns.close();
  expect(receipts.map(receipt => receipt.outcome), "GOVERNED_SHUTDOWN_IS_CANCELLED").toEqual(["cancelled"]);
  expect(warnings).toEqual([]);
});
