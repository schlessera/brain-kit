import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceTempBusyError, reserveMaintenanceTemp } from "@schlessera/brain-ui-sdk/internal";
import { createBrainClient, requeueWhenBusy } from "../src/brain/client.js";
import type { BrainExecution, HostBoundary } from "../src/brain/host-boundary.js";

// #3461: the automatic index and a turn's scratch-mask query share one
// maintenance budget. Production limits: one 256 MiB allowance in a 256 MiB
// budget, so the two can never overlap. A private shared-state domain keeps
// this ledger apart from every other test's.
const LIMITS = { allowanceBytes: 268435456, budgetBytes: 268435456 };
let root: string;
let domain: { statePath: string };
const held: ReturnType<typeof reserveMaintenanceTemp>[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-index-requeue-")));
  mkdirSync(join(root, "brain")); mkdirSync(join(root, "state"));
  domain = { statePath: join(root, "state", "ui.db") };
});
afterEach(() => {
  for (const reservation of held.splice(0)) reservation.release();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A worker boundary whose every run takes the real maintenance admission, as
 * `runMaintenanceWorker` does before launch, with the kind the client names.
 * Admission is the only part under test; no worker starts.
 */
function admittingBoundary(runs: (string | undefined)[]): HostBoundary {
  return {
    isolated: () => true,
    async run(execution: BrainExecution) {
      runs.push(execution.maintenanceKind);
      const reservation = reserveMaintenanceTemp(LIMITS, domain, execution.maintenanceKind ?? "command");
      try { return { stdout: "", stderr: "", exitCode: 0 }; } finally { reservation.release(); }
    },
  } as unknown as HostBoundary;
}

/** The hosted proof's own observation of each automatic index (`scripts/native-proof/hosted-app-child.ts`). */
function observed(index: () => Promise<void>) {
  const events: { kind: string; error?: string }[] = [];
  const run = async () => {
    events.push({ kind: "automatic_index_started" });
    try { await index(); events.push({ kind: "automatic_index_finished" }); }
    catch (error) { events.push({ kind: "automatic_index_failed", error: String(error) }); throw error; }
  };
  return { events, run };
}

function client(runs: (string | undefined)[], closing?: AbortSignal) {
  let pending!: () => void;
  const refused = new Promise<void>(resolve => { pending = resolve; });
  const logs: { body?: unknown; attributes?: Record<string, unknown> }[] = [];
  const brain = createBrainClient({ brainPath: join(root, "brain"), exec: {}, boundary: admittingBoundary(runs), ...(closing ? { closing } : {}),
    log: { emit(record: { body?: unknown; attributes?: Record<string, unknown> }) { logs.push(record); pending(); }, enabled: () => true } as never });
  return { brain, refused, logs };
}

test("an automatic index refused while a scratch query holds the budget stays pending, then completes", async () => {
  const scratch = reserveMaintenanceTemp(LIMITS, domain, "scratch_query"); held.push(scratch);
  const runs: (string | undefined)[] = [];
  const { brain, refused, logs } = client(runs);
  const automatic = observed(() => brain.index(requeueWhenBusy({})));
  const outcome = automatic.run();
  // Either the refusal is recorded as pending work, or the index has failed.
  await Promise.race([refused, outcome.catch(() => {})]);
  expect(automatic.events.find(event => event.kind === "automatic_index_failed")?.error, "AUTOMATIC_INDEX_REFUSED_AT_ADMISSION_STAYS_PENDING").toBeUndefined();
  expect(automatic.events.map(event => event.kind), "AUTOMATIC_INDEX_IS_PENDING_WHILE_HELD").toEqual(["automatic_index_started"]);
  expect(runs, "AUTOMATIC_INDEX_ADMISSION_WAS_REFUSED_ONCE").toEqual(["index"]);
  expect(logs[0]?.attributes?.holders, "AUTOMATIC_INDEX_PENDING_NAMES_THE_HOLDER_KIND").toBe("scratch query");
  scratch.release();
  await outcome;
  expect(automatic.events.map(event => event.kind), "AUTOMATIC_INDEX_COMPLETES_ONCE_THE_BUDGET_FREES")
    .toEqual(["automatic_index_started", "automatic_index_finished"]);
  expect(runs, "AUTOMATIC_INDEX_RUNS_AGAIN_AFTER_RELEASE").toEqual(["index", "index"]);
});

test("a requested index still reports busy at once and names the holder kind", async () => {
  held.push(reserveMaintenanceTemp(LIMITS, domain, "scratch_query"));
  const runs: (string | undefined)[] = [];
  const { brain } = client(runs);
  const error = await brain.index().then(() => undefined, caught => caught);
  expect(error, "REQUESTED_INDEX_IS_NOT_REQUEUED").toBeInstanceOf(MaintenanceTempBusyError);
  expect(String(error), "REQUESTED_INDEX_BUSY_NAMES_HOLDER").toContain("(held by: scratch query)");
  expect(runs, "REQUESTED_INDEX_RAN_ONCE").toEqual(["index"]);
});

test("close beginning discards a pending automatic index with its own reason", async () => {
  held.push(reserveMaintenanceTemp(LIMITS, domain, "scratch_query"));
  const runs: (string | undefined)[] = [];
  const closing = new AbortController(), reason = new Error("Server shutting down");
  const { brain, refused } = client(runs, closing.signal);
  const outcome = brain.index(requeueWhenBusy({}));
  await refused;
  closing.abort(reason);
  await expect(outcome, "PENDING_AUTOMATIC_INDEX_ENDS_WITH_CLOSE").rejects.toBe(reason);
  expect(runs, "PENDING_AUTOMATIC_INDEX_DID_NOT_RUN_AGAIN").toEqual(["index"]);
});
