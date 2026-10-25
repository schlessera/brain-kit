/**
 * Transient holds on a turn's authority to apply changes (#2853).
 *
 * A journal observation or a scope pause stops a turn's host effects for a
 * while; neither revokes its principal. A route that finds its authority held
 * waits, bounded and outside its locks, then checks again instead of refusing
 * as revoked. Nothing commits while a hold is active: the route's final
 * synchronous check before its commit still fails while one is.
 */

/** How long one wait for a turn's holds may last before the effect refuses. */
export const AUTHORITY_HOLD_WAIT_MS = 60_000;
/**
 * How often a waiting effect rechecks its turn: revocation and a scope pause's
 * answer have no event of their own, so neither is left to the journal or the bound.
 */
export const AUTHORITY_RECHECK_MS = 50;

export interface AuthorityHold {
  /** True while a hold stops the turn and its authority still stands; false once authority is gone. */
  active(): boolean;
  /** Settles when a hold may have cleared, such as the journal going idle. */
  settled(): Promise<unknown>;
  /** The longest one wait lasts, from the first hold it meets. */
  readonly waitMs: number;
}

/** A check found authority held rather than revoked: nothing was committed, and the route may wait and retry. */
export class AuthorityHeld extends Error {
  constructor() { super("This turn's changes are held by a journal observation or a scope pause."); this.name = "AuthorityHeld"; }
}

/**
 * Waits while `pending()` holds, rechecking it whenever `settled()` settles
 * and at least every `AUTHORITY_RECHECK_MS`. True once it no longer holds;
 * false when `signal` aborts or `deadline` passes first. `settled()` is
 * subscribed to once at a time, so rechecks never pile reactions onto a
 * stalled journal.
 */
export async function waitWhile(pending: () => boolean, settled: () => Promise<unknown>, signal: AbortSignal, deadline: number): Promise<boolean> {
  let subscribed = false, wake: (() => void) | undefined;
  while (pending()) {
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) return false;
    if (!subscribed) {
      subscribed = true;
      const done = () => { subscribed = false; wake?.(); };
      void settled().then(done, done);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(resolve => {
        wake = () => resolve(); timer = setTimeout(wake, Math.min(remaining, AUTHORITY_RECHECK_MS));
        signal.addEventListener("abort", wake, { once: true });
      });
    } finally { clearTimeout(timer); if (wake) signal.removeEventListener("abort", wake); wake = undefined; }
    // A settlement that is already due must not spin through microtasks.
    if (!subscribed) await new Promise(resolve => setImmediate(resolve));
  }
  return true;
}

/**
 * Waits until `hold` is no longer active, `signal` aborts or `deadline`
 * passes. True when no hold remains or authority is gone; the caller still
 * rechecks authority synchronously, in the tick its effect starts.
 */
export function waitForAuthority(hold: AuthorityHold, signal: AbortSignal, deadline: number): Promise<boolean> {
  return waitWhile(() => hold.active(), () => hold.settled(), signal, deadline);
}

/**
 * Runs the synchronous `check` at once, yielding only if it reports
 * `AuthorityHeld`: then it waits like `retryHeld`. A caller's synchronous
 * prefix stays synchronous while no hold is active.
 */
export function admitHeld(hold: AuthorityHold | undefined, signal: AbortSignal, check: () => void, expired: () => never,
  budget: { deadline?: number } = {}): Promise<void> | undefined {
  try { check(); return undefined; }
  catch (error) {
    if (!(error instanceof AuthorityHeld) || !hold) throw error;
    return retryHeld(hold, signal, check, expired, budget);
  }
}

/**
 * Runs `attempt` until it completes without reporting `AuthorityHeld`, waiting
 * out each hold in between. `expired` refuses once the wait passes its bound
 * or the turn is cancelled; an attempt that reports a hold has committed
 * nothing. Calls that share `budget` share one bound.
 */
export async function retryHeld<T>(hold: AuthorityHold | undefined, signal: AbortSignal, attempt: () => T | Promise<T>, expired: () => never,
  budget: { deadline?: number } = {}): Promise<T> {
  for (;;) {
    try { return await attempt(); }
    catch (error) {
      if (!(error instanceof AuthorityHeld) || !hold) throw error;
      budget.deadline ??= Date.now() + hold.waitMs;
      if (!await waitForAuthority(hold, signal, budget.deadline) || signal.aborted) expired();
    }
  }
}
