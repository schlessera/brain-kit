/**
 * Aggregate admission for Claude worker runtime state (#1625).
 *
 * Every worker's runtime state is its own private tmpfs of a fixed allowance,
 * so one worker can never fill another's. Those tmpfs mounts still share the
 * host's memory, so before a worker launches it reserves its whole allowance
 * against the server's runtime-state budget. Reserving is logical accounting,
 * not an allocation. Reserve and release are synchronous, so within the server
 * process no two admissions interleave. The ledger is one per process, shared
 * by every backend instance, so recreating a backend or changing its
 * configuration never forgets a running worker's reservation.
 */
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { FIRST_PARTY_FAILURE_CLASSES } from "@schlessera/brain-ui-sdk/protocol";
import { mib, type WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";

/** The worker-state classes; see `docs/hosting/agent-workers.md`. */
export type WorkerStateErrorClass = typeof FIRST_PARTY_FAILURE_CLASSES.worker_state_busy
  | typeof FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded;

/**
 * `worker_state_busy`: running workers hold the budget, so the turn was
 * refused before launch. `worker_state_exceeded`: the running turn filled its
 * allowance.
 */
export class WorkerStateError extends BackendRequestError {
  constructor(readonly errorClass: WorkerStateErrorClass, message: string) {
    super(message);
    this.name = "WorkerStateError";
  }
}

export interface Reservation {
  /** The allowance this worker was admitted with, fixed for its lifetime. */
  readonly bytes: number;
  /** Idempotent; every exit path calls it. */
  release(): void;
}

export interface StateLedger {
  /** Reserves the whole allowance against the budget, or refuses as `worker_state_busy`. */
  reserve(limits: WorkerStateLimits): Reservation;
  /** Bytes held by live reservations. */
  readonly held: number;
  /** Live reservations. */
  readonly live: number;
}

export function createStateLedger(): StateLedger {
  const entries = new Set<{ bytes: number }>();
  let held = 0;
  return {
    get held() { return held; },
    get live() { return entries.size; },
    reserve({ allowanceBytes, budgetBytes }) {
      // Each live reservation keeps its own bytes. A budget lowered since it
      // was admitted refuses new workers until enough of them finish.
      if (held + allowanceBytes > budgetBytes) {
        const running = entries.size;
        throw new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy,
          `Not enough worker runtime-state capacity for this turn right now: it needs its ${mib(allowanceBytes)} allowance, `
          + `and ${running} running conversation${running === 1 ? "" : "s"} hold${running === 1 ? "s" : ""} ${mib(held)} `
          + `of the server's ${mib(budgetBytes)} budget. Nothing was sent. Retry when a running conversation finishes; `
          + "docs/hosting/agent-workers.md explains how to size the budget.");
      }
      const entry = { bytes: allowanceBytes };
      entries.add(entry);
      held += entry.bytes;
      return {
        bytes: entry.bytes,
        release() { if (entries.delete(entry)) held -= entry.bytes; },
      };
    },
  };
}

const PROCESS_LEDGER = Symbol.for("@schlessera/brain-backend-claude/worker-state-ledger");
/** The server process's one ledger, even if this module is loaded twice (source and build). */
export function processStateLedger(): StateLedger {
  const slot = globalThis as { [PROCESS_LEDGER]?: StateLedger };
  return slot[PROCESS_LEDGER] ??= createStateLedger();
}
