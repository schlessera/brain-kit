/**
 * The owner of a refused end-of-turn worker cleanup (#2871).
 *
 * A Claude turn awaits its worker's handle cleanup before it releases the
 * turn's runtime-state reservation, and an unconfirmed close keeps that
 * reservation charged (#2854). The turn still fails, and nothing of the turn
 * waits for this owner. It retains the retryable close and the reservation,
 * retries the close a finite number of times with backoff, and releases the
 * reservation exactly once, only after a close is confirmed. A retry that is
 * still refused after the last attempt is logged with the allowance it keeps
 * charged. Shutdown stops the retries, reports what is still held and
 * releases nothing.
 */
import { mib } from "@schlessera/brain-ui-sdk/internal";

/** One refused cleanup, handed over by the turn that could not confirm it. */
export interface RetainedCleanup {
  /** The runtime-state bytes the reservation keeps charged. */
  readonly bytes: number;
  /** The turn-temp bytes the reservation keeps charged. */
  readonly turnTempBytes: number;
  /** Resolves only once the cleanup is confirmed; rejects, retryably, while it is not. */
  close(): Promise<void>;
  /** Releases the reservation; called once, after a confirmed close. */
  release(): void;
}

export interface CleanupReconcilerOptions {
  /** Retries before a refusal is terminal. */
  attempts?: number;
  /** The delay before the first retry; each later one doubles it. */
  baseDelayMs?: number;
  /** The longest delay between two retries. */
  maxDelayMs?: number;
  /** Host diagnostics; never the wire. */
  log?: (message: string, error?: unknown) => void;
  /** Schedules a retry and returns its cancel. Defaults to an unreferenced timer, so a retry never holds the process open. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface CleanupReconciler {
  /** Takes ownership of a refused cleanup and its reservation. */
  retain(cleanup: RetainedCleanup): void;
  /** Cleanups still charged, retrying or terminal. */
  readonly held: number;
  /**
   * Stops every retry without releasing anything or waiting for a close in
   * flight, and logs what is still charged. Idempotent.
   */
  close(): { held: number; bytes: number; turnTempBytes: number };
}

export const CLEANUP_RETRY_ATTEMPTS = 5;
export const CLEANUP_RETRY_BASE_MS = 1_000;
export const CLEANUP_RETRY_MAX_MS = 30_000;

const unreferencedTimer = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

const allowance = (bytes: number, turnTempBytes: number) =>
  `${mib(bytes)} of runtime state and ${mib(turnTempBytes)} of turn temp`;

export function createCleanupReconciler(options: CleanupReconcilerOptions = {}): CleanupReconciler {
  const attempts = options.attempts ?? CLEANUP_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? CLEANUP_RETRY_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? CLEANUP_RETRY_MAX_MS;
  const log = options.log ?? ((message: string, error?: unknown) => {
    if (error === undefined) console.error(message); else console.error(message, error);
  });
  const schedule = options.schedule ?? unreferencedTimer;
  /** Every cleanup still charged, with its pending retry's cancel, if any. */
  const held = new Map<RetainedCleanup, (() => void) | undefined>();
  let closed = false;

  const attempt = (cleanup: RetainedCleanup, made: number) => {
    held.set(cleanup, undefined);
    void (async () => {
      try { await cleanup.close(); }
      catch (error) {
        if (closed || !held.has(cleanup)) return;
        if (made + 1 < attempts) { plan(cleanup, made + 1); return; }
        // Terminal: the allowance stays charged until the server restarts.
        log(`Claude worker cleanup is still unconfirmed after ${attempts} retries; `
          + `${allowance(cleanup.bytes, cleanup.turnTempBytes)} stay charged until the server restarts.`, error);
        return;
      }
      // Shutdown releases nothing, even a close confirmed after it began.
      if (closed || !held.delete(cleanup)) return;
      cleanup.release();
    })();
  };

  const plan = (cleanup: RetainedCleanup, made: number) => {
    const delay = Math.min(baseDelayMs * 2 ** made, maxDelayMs);
    held.set(cleanup, schedule(() => { if (!closed && held.has(cleanup)) attempt(cleanup, made); }, delay));
  };

  return {
    get held() { return held.size; },
    retain(cleanup) {
      if (held.has(cleanup)) return;
      if (closed) {
        held.set(cleanup, undefined);
        log(`Claude worker cleanup is unconfirmed during shutdown; ${allowance(cleanup.bytes, cleanup.turnTempBytes)} stay charged.`);
        return;
      }
      if (attempts <= 0) { held.set(cleanup, undefined); return; }
      plan(cleanup, 0);
    },
    close() {
      let bytes = 0, turnTempBytes = 0;
      for (const [cleanup, cancel] of held) { cancel?.(); held.set(cleanup, undefined); bytes += cleanup.bytes; turnTempBytes += cleanup.turnTempBytes; }
      const summary = { held: held.size, bytes, turnTempBytes };
      if (!closed && summary.held) {
        log(`Claude worker cleanup reconciliation stopped with ${summary.held} unconfirmed cleanup${summary.held === 1 ? "" : "s"} `
          + `still holding ${allowance(bytes, turnTempBytes)}.`);
      }
      closed = true;
      return summary;
    },
  };
}

// One per process, as the ledger it releases into is (`processStateLedger`).
const PROCESS_RECONCILER = Symbol.for(["@schlessera", "brain-backend-claude", "cleanup-reconciler"].join("/"));
/** The server process's one reconciler; it stops and reports when the process exits. */
export function processCleanupReconciler(): CleanupReconciler {
  const slot = globalThis as { [PROCESS_RECONCILER]?: CleanupReconciler };
  if (!slot[PROCESS_RECONCILER]) {
    const reconciler = slot[PROCESS_RECONCILER] = createCleanupReconciler();
    process.once("exit", () => { reconciler.close(); });
  }
  return slot[PROCESS_RECONCILER];
}
