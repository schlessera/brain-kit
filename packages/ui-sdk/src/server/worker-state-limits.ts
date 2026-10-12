/**
 * The runtime-state allowance of an agent worker and the aggregate budget the
 * server admits workers against (#1625).
 *
 * Every worker gets a private tmpfs of exactly `allowanceBytes` for its
 * runtime state, and reserves that whole allowance against `budgetBytes`
 * before it launches. One resolved value drives the mount size, the
 * reservation, the copy guards, diagnostics and the agent's note. Both come
 * from trusted host configuration, never from brain content.
 *
 * Turn temp (#1703) has its own allowance and budget of the same shape: each
 * worker's `/tmp` is a private tmpfs of exactly its allowance.
 */

/** tmpfs allocates whole pages; an allowance must be a whole number of them. */
export const WORKER_STATE_PAGE = 4096;
/** 64 MiB, the maintainer's default (#1625). */
export const DEFAULT_WORKER_STATE_BYTES = 64 * 1024 * 1024;
/** The host's own default for its concurrent-session cap. */
export const DEFAULT_WORKER_STATE_SESSIONS = 3;
export const WORKER_STATE_BYTES_ENV = "BRAIN_UI_WORKER_STATE_BYTES";
export const WORKER_STATE_BUDGET_ENV = "BRAIN_UI_WORKER_STATE_BUDGET_BYTES";
/** 256 MiB, the maintainer's default for each worker's turn temp (#1703). */
export const DEFAULT_TURN_TEMP_BYTES = 256 * 1024 * 1024;
export const TURN_TEMP_BYTES_ENV = "BRAIN_UI_TURN_TEMP_BYTES";
export const TURN_TEMP_BUDGET_ENV = "BRAIN_UI_TURN_TEMP_BUDGET_BYTES";

export interface WorkerStateLimits {
  /** Each worker's private runtime-state tmpfs, reserved in full before launch. */
  allowanceBytes: number;
  /** What all running workers' allowances may add up to. */
  budgetBytes: number;
}

export class WorkerStateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStateConfigError";
  }
}

export const mib = (bytes: number): string => {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`;
};

/** A whole, positive, page-aligned byte count, or a clear refusal naming `name`. */
export function validWorkerStateBytes(value: unknown, name: string, example = DEFAULT_WORKER_STATE_BYTES): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value % WORKER_STATE_PAGE !== 0) {
    throw new WorkerStateConfigError(`${name} must be a positive whole number of bytes that is a multiple of `
      + `${WORKER_STATE_PAGE} (for example ${example} for ${mib(example)}); got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Parses a configured byte count: digits only, no unit, sign, fraction or exponent. */
export function parseWorkerStateBytes(raw: string | undefined, name: string, example = DEFAULT_WORKER_STATE_BYTES): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new WorkerStateConfigError(`${name} must be a whole number of bytes, digits only (for example `
      + `${example} for ${mib(example)}); got ${JSON.stringify(raw)}.`);
  }
  return validWorkerStateBytes(Number(text), name, example);
}

interface LimitsInput {
  allowanceBytes?: number;
  budgetBytes?: number;
  maxConcurrentSessions?: number;
  /** Names the settings in refusals; defaults to the host's environment variables. */
  names?: { allowance: string; budget: string };
}

/**
 * One allowance and the aggregate budget it is admitted against. The budget
 * defaults to the allowance times the concurrent-session cap; an explicit
 * budget may admit fewer workers than that cap, but never fewer than one.
 */
function resolveLimits(input: LimitsInput, defaults: { bytes: number; names: { allowance: string; budget: string } }): WorkerStateLimits {
  const names = input.names ?? defaults.names;
  const allowanceBytes = input.allowanceBytes === undefined ? defaults.bytes
    : validWorkerStateBytes(input.allowanceBytes, names.allowance, defaults.bytes);
  let budgetBytes: number;
  if (input.budgetBytes === undefined) {
    const sessions = input.maxConcurrentSessions ?? DEFAULT_WORKER_STATE_SESSIONS;
    if (!Number.isFinite(sessions) || sessions < 1) {
      throw new WorkerStateConfigError(`The concurrent-session cap must be at least 1 to derive ${names.budget}; got ${sessions}.`);
    }
    // A fractional cap admits up to its ceiling, so the budget covers that many.
    budgetBytes = allowanceBytes * Math.ceil(sessions);
    if (!Number.isSafeInteger(budgetBytes)) {
      throw new WorkerStateConfigError(`${names.allowance} times the concurrent-session cap (${Math.ceil(sessions)}) `
        + `overflows; set ${names.budget} explicitly or lower either value.`);
    }
  } else {
    budgetBytes = validWorkerStateBytes(input.budgetBytes, names.budget, defaults.bytes);
  }
  if (budgetBytes < allowanceBytes) {
    throw new WorkerStateConfigError(`${names.budget} (${budgetBytes} bytes) is smaller than one worker's `
      + `${names.allowance} (${allowanceBytes} bytes), so no worker could ever start.`);
  }
  return { allowanceBytes, budgetBytes };
}

/** Resolves and validates the runtime-state allowance and its budget (#1625). */
export function resolveWorkerStateLimits(input: LimitsInput): WorkerStateLimits {
  return resolveLimits(input, { bytes: DEFAULT_WORKER_STATE_BYTES,
    names: { allowance: WORKER_STATE_BYTES_ENV, budget: WORKER_STATE_BUDGET_ENV } });
}

/**
 * Resolves and validates the turn-temp allowance and its budget (#1703): the
 * size of each worker's private `/tmp`, which holds `$BRAIN_WORKER_SCRATCH`
 * and the per-turn XDG directories, and what all running workers' turn temp
 * may add up to. Its own allowance, apart from runtime state's, admitted in
 * the same ledger.
 */
export function resolveTurnTempLimits(input: LimitsInput): WorkerStateLimits {
  return resolveLimits(input, { bytes: DEFAULT_TURN_TEMP_BYTES,
    names: { allowance: TURN_TEMP_BYTES_ENV, budget: TURN_TEMP_BUDGET_ENV } });
}
