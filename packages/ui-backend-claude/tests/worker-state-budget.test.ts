/** Aggregate runtime-state admission (#1625): whole allowances against one budget. */
import { expect, test } from "bun:test";
import { createStateLedger, processStateLedger, WorkerStateError } from "../src/worker-state-budget.js";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { exceededFailure, stateExhausted, workerStateClass } from "../src/worker-spawn.js";

const MiB = 1024 * 1024;
const DEFAULT = { allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB };

function refusal(run: () => unknown): WorkerStateError {
  try { run(); } catch (error) { if (error instanceof WorkerStateError) return error; throw error; }
  throw new Error("expected a worker_state_busy refusal");
}

test("the default budget admits three workers' full allowances and refuses the fourth as worker_state_busy", () => {
  const ledger = createStateLedger();
  const held = [1, 2, 3].map(() => ledger.reserve(DEFAULT));
  expect(held.map(h => h.bytes)).toEqual([64 * MiB, 64 * MiB, 64 * MiB]);
  expect(ledger.held).toBe(192 * MiB);
  const error = refusal(() => ledger.reserve(DEFAULT));
  expect(error.errorClass).toBe("worker_state_busy");
  expect(error.message).toContain("it needs its 64 MiB allowance, and 3 running conversations hold 192 MiB of the server's 192 MiB budget");
  expect(error.message).toContain("Nothing was sent");
  expect(ledger.live, "a refusal holds nothing").toBe(3);
});

test("release permits Retry, and releasing twice frees nothing more", () => {
  const ledger = createStateLedger();
  const first = ledger.reserve({ allowanceBytes: 64 * MiB, budgetBytes: 64 * MiB });
  refusal(() => ledger.reserve({ allowanceBytes: 64 * MiB, budgetBytes: 64 * MiB }));
  first.release(); first.release();
  expect(ledger.held).toBe(0);
  const retry = ledger.reserve({ allowanceBytes: 64 * MiB, budgetBytes: 64 * MiB });
  const other = ledger.reserve({ allowanceBytes: 64 * MiB, budgetBytes: 128 * MiB });
  expect(ledger.held).toBe(128 * MiB);
  retry.release(); other.release();
});

test("a lower budget override refuses the next worker before the session cap", () => {
  const ledger = createStateLedger();
  const override = { allowanceBytes: 64 * MiB, budgetBytes: 128 * MiB };
  ledger.reserve(override); ledger.reserve(override);
  expect(refusal(() => ledger.reserve(override)).message).toContain("2 running conversations");
});

test("live reservations keep their admitted allowance when the configuration changes", () => {
  const ledger = createStateLedger();
  const before = ledger.reserve({ allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB });
  // A smaller allowance and budget afterwards: the running worker keeps its 64 MiB, and still counts.
  expect(before.bytes).toBe(64 * MiB);
  refusal(() => ledger.reserve({ allowanceBytes: 32 * MiB, budgetBytes: 64 * MiB }));
  const after = ledger.reserve({ allowanceBytes: 32 * MiB, budgetBytes: 96 * MiB });
  expect([before.bytes, after.bytes, ledger.held]).toEqual([64 * MiB, 32 * MiB, 96 * MiB]);
  before.release();
  expect(ledger.held).toBe(32 * MiB);
  after.release();
});

test("the process has one ledger, whichever module copy asks", () => {
  expect(processStateLedger()).toBe(processStateLedger());
  const key = Symbol.for("@schlessera/brain-backend-claude/worker-state-ledger");
  expect((globalThis as Record<symbol, unknown>)[key]).toBe(processStateLedger());
});

test("exhaustion is read from the private tmpfs, or from the runtime's own write error", () => {
  const space = (free: number) => ({ space: () => ({ total: 64 * MiB, free }) });
  expect(stateExhausted(space(0), "")).toBe(true);
  expect(stateExhausted(space(4095), "")).toBe(true);
  expect(stateExhausted(space(4096), "")).toBe(false);
  expect(stateExhausted(space(32 * MiB), "Error: ENOSPC: no space left on device, write")).toBe(false);
  expect(stateExhausted(space(32 * MiB), "ENOSPC: write /tmp/flood")).toBe(false);
  expect(stateExhausted(space(32 * MiB), "ENOSPC: write /tmp/brain-worker-state/projects/ithaca.jsonl")).toBe(true);
  expect(stateExhausted({ space: () => { throw new Error("closed"); } }, "")).toBe(false);
});

test("the exhaustion message claims kept state only when the copy-out succeeded", () => {
  expect(exceededFailure(64 * MiB).message).toContain("What it wrote before then is kept");
  const refused = exceededFailure(64 * MiB, new WorkerHostError("runtime state contains an alias or special file"));
  expect(refused.message).not.toContain("is kept");
  expect(refused.message).toContain("could not be saved in full either: Runtime state contained a link, alias or special file");
});

test("a worker-state refusal is recognized by class, from any copy of the module", () => {
  expect(workerStateClass(new WorkerStateError("worker_state_busy", "busy"))).toBe("worker_state_busy");
  expect(workerStateClass(Object.assign(new Error("busy elsewhere"), { errorClass: "worker_state_busy" }))).toBe("worker_state_busy");
  expect(workerStateClass(Object.assign(new Error("x"), { errorClass: "session_too_large" }))).toBeUndefined();
  expect(workerStateClass(null)).toBeUndefined();
});

test("turn temp is admitted with runtime state, both or neither, against its own budget (#1703)", () => {
  const ledger = createStateLedger();
  const state = { allowanceBytes: 64 * MiB, budgetBytes: 128 * MiB };
  const turnTemp = { allowanceBytes: 256 * MiB, budgetBytes: 256 * MiB };
  const first = ledger.reserve(state, turnTemp);
  expect(first).toMatchObject({ bytes: 64 * MiB, turnTempBytes: 256 * MiB });
  expect([ledger.held, ledger.turnTempHeld]).toEqual([64 * MiB, 256 * MiB]);
  // Runtime state still fits; turn temp does not: nothing is held for the refused worker.
  const busy = refusal(() => ledger.reserve(state, turnTemp));
  expect(busy.errorClass).toBe("worker_state_busy");
  expect(busy.message).toContain("Not enough worker turn-temp capacity for this turn right now: it needs its 256 MiB allowance");
  expect([ledger.held, ledger.turnTempHeld, ledger.live]).toEqual([64 * MiB, 256 * MiB, 1]);
  // A worker with only turn temp (the pi backend) reserves no runtime state.
  first.release();
  const pi = ledger.reserve(undefined, turnTemp);
  expect(pi).toMatchObject({ bytes: 0, turnTempBytes: 256 * MiB });
  expect([ledger.held, ledger.turnTempHeld]).toEqual([0, 256 * MiB]);
  pi.release(); pi.release();
  expect([ledger.held, ledger.turnTempHeld, ledger.live]).toEqual([0, 0, 0]);
});
