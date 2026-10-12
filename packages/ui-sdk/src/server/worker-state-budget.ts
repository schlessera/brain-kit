/**
 * Aggregate admission for agent workers' private tmpfs mounts: runtime state
 * (#1625) and turn temp (#1703).
 *
 * Each worker's runtime state and its `/tmp` are private tmpfs mounts of a
 * fixed allowance, so one worker can never fill another's. Those mounts still
 * share the host's memory, so before a worker launches it reserves each whole
 * allowance against the server's budget for it. Reserving is logical
 * accounting, not an allocation. A worker's allowances are reserved together
 * or not at all. Reserve and release are synchronous, so within the server
 * process no two admissions interleave. The ledger is one per process, shared
 * by every backend instance and both backends, so recreating a backend or
 * changing its configuration never forgets a running worker's reservation.
 */
import { BackendRequestError } from "./backend.js";
import { FIRST_PARTY_FAILURE_CLASSES } from "../protocol.js";
import { mib, type WorkerStateLimits } from "./worker-state-limits.js";

/** The worker-state classes; see `docs/hosting/agent-workers.md`. */
export type WorkerStateErrorClass = typeof FIRST_PARTY_FAILURE_CLASSES.worker_state_busy
  | typeof FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded;

/**
 * `worker_state_busy`: running workers hold a budget, so the turn was refused
 * before launch. `worker_state_exceeded`: the running turn filled its
 * runtime-state allowance.
 */
export class WorkerStateError extends BackendRequestError {
  constructor(readonly errorClass: WorkerStateErrorClass, message: string) {
    super(message);
    this.name = "WorkerStateError";
  }
}

export interface Reservation {
  /** The runtime-state allowance this worker was admitted with, fixed for its lifetime; 0 without one. */
  readonly bytes: number;
  /** The turn-temp allowance this worker was admitted with, fixed for its lifetime; 0 without one. */
  readonly turnTempBytes: number;
  /** Idempotent; every exit path calls it. */
  release(): void;
}

export interface StateLedger {
  /**
   * Reserves each whole allowance against its budget, both or neither, or
   * refuses as `worker_state_busy`. `limits` is runtime state's, `turnTemp`
   * turn temp's; either may be absent.
   */
  reserve(limits: WorkerStateLimits | undefined, turnTemp?: WorkerStateLimits): Reservation;
  /** Runtime-state bytes held by live reservations. */
  readonly held: number;
  /** Turn-temp bytes held by live reservations. */
  readonly turnTempHeld: number;
  /** Live reservations. */
  readonly live: number;
}

export function createStateLedger(): StateLedger {
  const entries = new Set<{ bytes: number; turnTempBytes: number }>();
  let held = 0, turnTempHeld = 0;
  const busy = (what: string, allowance: number, inUse: number, budget: number) => {
    const running = entries.size;
    return new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy,
      `Not enough worker ${what} capacity for this turn right now: it needs its ${mib(allowance)} allowance, `
      + `and ${running} running conversation${running === 1 ? "" : "s"} hold${running === 1 ? "s" : ""} ${mib(inUse)} `
      + `of the server's ${mib(budget)} budget. Nothing was sent. Retry when a running conversation finishes; `
      + "docs/hosting/agent-workers.md explains how to size the budget.");
  };
  return {
    get held() { return held; },
    get turnTempHeld() { return turnTempHeld; },
    get live() { return entries.size; },
    reserve(limits, turnTemp) {
      // Each live reservation keeps its own bytes. A budget lowered since it
      // was admitted refuses new workers until enough of them finish.
      if (limits && held + limits.allowanceBytes > limits.budgetBytes) {
        throw busy("runtime-state", limits.allowanceBytes, held, limits.budgetBytes);
      }
      if (turnTemp && turnTempHeld + turnTemp.allowanceBytes > turnTemp.budgetBytes) {
        throw busy("turn-temp", turnTemp.allowanceBytes, turnTempHeld, turnTemp.budgetBytes);
      }
      const entry = { bytes: limits?.allowanceBytes ?? 0, turnTempBytes: turnTemp?.allowanceBytes ?? 0 };
      entries.add(entry);
      held += entry.bytes;
      turnTempHeld += entry.turnTempBytes;
      return {
        bytes: entry.bytes,
        turnTempBytes: entry.turnTempBytes,
        release() {
          if (!entries.delete(entry)) return;
          held -= entry.bytes;
          turnTempHeld -= entry.turnTempBytes;
        },
      };
    },
  };
}

// The key predates the ledger's move from the Claude backend, so an older copy
// of that backend loaded beside this one still shares the one ledger.
const PROCESS_LEDGER = Symbol.for("@schlessera/brain-backend-claude/worker-state-ledger");
/** The server process's one ledger, even if this module is loaded twice (source and build). */
export function processStateLedger(): StateLedger {
  const slot = globalThis as { [PROCESS_LEDGER]?: StateLedger };
  return slot[PROCESS_LEDGER] ??= createStateLedger();
}
