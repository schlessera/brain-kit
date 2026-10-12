/**
 * The runtime-state allowance of an agent worker and the aggregate budget the
 * server admits workers against (#1625).
 *
 * Every worker gets a private tmpfs of exactly `allowanceBytes` for its
 * runtime state, and reserves that whole allowance against `budgetBytes`
 * before it launches. One resolved value drives the mount size, the
 * reservation, the copy guards, diagnostics and the agent's note. Both come
 * from trusted host configuration, never from brain content.
 */

/** tmpfs allocates whole pages; an allowance must be a whole number of them. */
export const WORKER_STATE_PAGE = 4096;
/** 64 MiB, the maintainer's default (#1625). */
export const DEFAULT_WORKER_STATE_BYTES = 64 * 1024 * 1024;
/** The host's own default for its concurrent-session cap. */
export const DEFAULT_WORKER_STATE_SESSIONS = 3;
export const WORKER_STATE_BYTES_ENV = "BRAIN_UI_WORKER_STATE_BYTES";
export const WORKER_STATE_BUDGET_ENV = "BRAIN_UI_WORKER_STATE_BUDGET_BYTES";

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
export function validWorkerStateBytes(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value % WORKER_STATE_PAGE !== 0) {
    throw new WorkerStateConfigError(`${name} must be a positive whole number of bytes that is a multiple of `
      + `${WORKER_STATE_PAGE} (for example ${DEFAULT_WORKER_STATE_BYTES} for 64 MiB); got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Parses a configured byte count: digits only, no unit, sign, fraction or exponent. */
export function parseWorkerStateBytes(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new WorkerStateConfigError(`${name} must be a whole number of bytes, digits only (for example `
      + `${DEFAULT_WORKER_STATE_BYTES} for 64 MiB); got ${JSON.stringify(raw)}.`);
  }
  return validWorkerStateBytes(Number(text), name);
}

/**
 * Resolves and validates both limits. The budget defaults to the allowance
 * times the concurrent-session cap; an explicit budget may admit fewer
 * workers than that cap, but never fewer than one.
 */
export function resolveWorkerStateLimits(input: {
  allowanceBytes?: number;
  budgetBytes?: number;
  maxConcurrentSessions?: number;
  /** Names the settings in refusals; defaults to the host's environment variables. */
  names?: { allowance: string; budget: string };
}): WorkerStateLimits {
  const names = input.names ?? { allowance: WORKER_STATE_BYTES_ENV, budget: WORKER_STATE_BUDGET_ENV };
  const allowanceBytes = input.allowanceBytes === undefined ? DEFAULT_WORKER_STATE_BYTES
    : validWorkerStateBytes(input.allowanceBytes, names.allowance);
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
    budgetBytes = validWorkerStateBytes(input.budgetBytes, names.budget);
  }
  if (budgetBytes < allowanceBytes) {
    throw new WorkerStateConfigError(`${names.budget} (${budgetBytes} bytes) is smaller than one worker's `
      + `${names.allowance} (${allowanceBytes} bytes), so no worker could ever start.`);
  }
  return { allowanceBytes, budgetBytes };
}
