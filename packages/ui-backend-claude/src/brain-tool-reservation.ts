/** Runtime and brain relay divide one turn's admitted temp allowance. */
import { processStateLedger, type Reservation, type StateLedger } from "./worker-state-budget.js";
import type { WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";

const PAGE = 4096;
export function createBridgedTurnReservation(state: WorkerStateLimits, temp: WorkerStateLimits, ledger: StateLedger = processStateLedger()) {
  if (temp.allowanceBytes < 2 * PAGE) throw new Error("A bridged turn needs at least two pages of turn temp.");
  const brainBytes = Math.floor(temp.allowanceBytes / 2 / PAGE) * PAGE;
  const runtimeTemp = { ...temp, allowanceBytes: temp.allowanceBytes - brainBytes };
  let held: Reservation | undefined, closed = false;
  const active = new Set<"runtime" | "brain">();
  const release = () => { if (closed && active.size === 0) held?.release(); };
  const acquire = (owner: "runtime" | "brain"): Reservation => {
    if (closed || active.has(owner)) throw new Error(`The bridged turn's ${owner} reservation is already owned or closed.`);
    held ??= ledger.reserve(state, temp);
    active.add(owner);
    let released = false;
    return { bytes: owner === "runtime" ? held.bytes : 0, turnTempBytes: owner === "runtime" ? runtimeTemp.allowanceBytes : brainBytes,
      outputStagingBytes: 0, release() { if (released) return; released = true; active.delete(owner); release(); } };
  };
  return { runtimeTemp, runtime: () => acquire("runtime"), brain: () => acquire("brain"),
    close() { closed = true; release(); } };
}
