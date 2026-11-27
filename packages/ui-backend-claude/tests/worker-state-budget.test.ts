/** How the Claude worker reads and reports runtime-state exhaustion (#1625); the ledger itself is tested in ui-sdk. */
import { expect, test } from "bun:test";
import { WorkerHostError, WorkerStateError } from "@schlessera/brain-ui-sdk/internal";
import { exceededFailure, stateExhausted, workerStateClass } from "../src/worker-spawn.js";

const MiB = 1024 * 1024;

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
