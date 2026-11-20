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
