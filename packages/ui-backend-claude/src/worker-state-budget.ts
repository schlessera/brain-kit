/**
 * The shared budget for Claude worker runtime state (#1625).
 *
 * Every Claude turn's state directory sits on one tmpfs, the host's
 * `/dev/shm`. A free-space reading alone is not admission: two turns can both
 * see enough room, then both copy and both fail with `ENOSPC`. So a turn
 * reserves what it copies in plus room to grow, against the tmpfs's real free
 * space less what running turns have reserved and not yet written. Reserving,
 * copying and releasing are synchronous, so within one server process
 * check-then-copy cannot interleave with another turn's.
 */
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

/** tmpfs allocates whole pages, so every byte count is rounded up to one. */
const PAGE = 4096;
export const pages = (bytes: number): number => Math.ceil(bytes / PAGE) * PAGE;
export const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export interface TmpfsSpace {
  /** Bytes an unprivileged writer can still allocate. */
  free: number;
  /** The filesystem's size. */
  total: number;
}

export function tmpfsSpace(path: string): TmpfsSpace {
  const info = statfsSync(path);
  // A tmpfs mounted with size=0 has no limit and reports no blocks.
  if (info.blocks === 0) return { free: Number.POSITIVE_INFINITY, total: Number.POSITIVE_INFINITY };
  return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
}

/** Bytes a state directory's files occupy, in pages, never following a link. */
export function usage(path: string): number {
  let info;
  try { info = lstatSync(path); } catch { return 0; }
  if (info.isFile()) return pages(info.size);
  if (!info.isDirectory()) return 0;
  let names: string[];
  try { names = readdirSync(path); } catch { return 0; }
  // A tmpfs directory takes an inode, not data pages.
  return names.reduce((total, name) => total + usage(join(path, name)), 0);
}

/** The worker-state classes this ledger names; see `docs/hosting/agent-workers.md`. */
export type WorkerStateErrorClass = "worker_state_busy" | "worker_state_exceeded";

/** A turn refused, or stopped, because running turns hold the runtime-state space. */
export class WorkerStateError extends BackendRequestError {
  constructor(readonly errorClass: WorkerStateErrorClass, message: string) {
    super(message);
    this.name = "WorkerStateError";
  }
}

export interface Reservation {
  /** Bytes currently held for this state directory. */
  readonly bytes: number;
  /**
   * Called while the turn runs. Keeps at least half a growth step reserved
   * beyond what the state already uses, extending into space no other turn
   * holds. Throws `worker_state_exceeded` once the state has outgrown its
   * reservation and cannot extend it, or has passed the per-turn bound.
   */
  ensure(): void;
  /** Idempotent; every exit path calls it. */
  release(): void;
}

export interface ReserveRequest {
  /** The state directory the reservation covers; its usage is measured. */
  path: string;
  /** Bytes to hold: what is copied in plus the turn's growth headroom. */
  bytes: number;
  /** The tmpfs as it is now, read after the state directory was created. */
  space: TmpfsSpace;
}

export interface StateLedger {
  reserve(request: ReserveRequest): Reservation;
  /** Live reservations, for tests and diagnostics. */
  readonly live: number;
}

export function createStateLedger(options: {
  /** Re-reads the tmpfs while a turn runs. */
  space: (path: string) => TmpfsSpace;
  /** The step a running turn's reservation grows by. */
  growth: number;
  /** One turn's state may never pass this, whatever the tmpfs holds. */
  max: number;
  measure?: (path: string) => number;
}): StateLedger {
  const measure = options.measure ?? usage;
  const held = new Set<{ path: string; bytes: number }>();
  /** Reserved by other turns and not yet written: the tmpfs's free space still counts it. */
  const outstanding = (except?: object) => {
    let sum = 0;
    for (const entry of held) if (entry !== except) sum += Math.max(0, entry.bytes - measure(entry.path));
    return sum;
  };
  return {
    get live() { return held.size; },
    reserve({ path, bytes, space }) {
      const others = held.size;
      const available = space.free - outstanding();
      if (bytes > available) {
        throw new WorkerStateError("worker_state_busy", "Not enough worker runtime space for this turn right now: "
          + `it needs ${mib(bytes)} and ${mib(Math.max(0, available))} is free`
          + (others ? `, with ${others} other conversation${others === 1 ? "" : "s"} running` : "")
          + ". Try again when a running conversation finishes; see docs/hosting/agent-workers.md to size /dev/shm for parallel sessions.");
      }
      const entry = { path, bytes };
      held.add(entry);
      return {
        get bytes() { return entry.bytes; },
        ensure() {
          if (!held.has(entry)) return;
          const used = measure(path);
          if (used > options.max) {
            throw new WorkerStateError("worker_state_exceeded", `This turn's runtime state grew to ${mib(used)}, `
              + `past the ${mib(options.max)} one turn may hold. The turn was stopped; what it saved so far is kept.`);
          }
          if (entry.bytes - used >= options.growth / 2) return;
          const wanted = Math.min(options.max, used + options.growth);
          if (wanted > entry.bytes && wanted - used <= options.space(path).free - outstanding(entry)) {
            entry.bytes = wanted;
            return;
          }
          if (used <= entry.bytes) return;
          throw new WorkerStateError("worker_state_exceeded", `This turn's runtime state grew to ${mib(used)}, `
            + `past its ${mib(entry.bytes)} reservation, and other conversations hold the rest of the space. `
            + "The turn was stopped before the space ran out; what it saved so far is kept.");
        },
        release() { held.delete(entry); },
      };
    },
  };
}

const ledgers = new Map<string, StateLedger>();
/** The server process's one ledger per state root (normally `/dev/shm`). */
export function stateLedger(root: string, growth: number, max: number): StateLedger {
  let ledger = ledgers.get(root);
  if (!ledger) ledgers.set(root, ledger = createStateLedger({ space: tmpfsSpace, growth, max }));
  return ledger;
}
