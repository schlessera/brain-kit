/**
 * Advisory write lock — serializes MUTATING tool executions across all
 * sessions of a backend that share one working tree. Read tools run fully
 * parallel; write/edit/bash/ingest-class tools take the lock for the span of
 * their execution so two agents never interleave file writes or git
 * operations (index.lock, hooks) in the same repo. Write bursts are short
 * next to model latency, so contention cost is negligible.
 *
 * Plain FIFO promise-chain mutex. In-process only by design: brain-ui runs
 * one backend instance per deployment, so one lock instance covers all its
 * sessions. Cross-process writers (a terminal agent in the same repo) are
 * out of scope — same exposure as today.
 */

export interface WriteLock {
  /** True while a holder has the lock (diagnostics only — never poll this). */
  readonly locked: boolean;
  /** Acquire; resolves with the release function. Prefer withLock(). */
  acquire(): Promise<() => void>;
  /** Run `fn` with the lock held; releases on resolve AND reject. */
  withLock<T>(fn: () => Promise<T> | T): Promise<T>;
}

export function createWriteLock(): WriteLock {
  let tail: Promise<void> = Promise.resolve();
  let holders = 0;

  return {
    get locked() {
      return holders > 0;
    },

    acquire(): Promise<() => void> {
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        let released = false;
        release = () => {
          if (released) return; // double-release is a no-op
          released = true;
          holders -= 1;
          resolve();
        };
      });
      const acquired = tail.then(() => {
        holders += 1;
        return release;
      });
      tail = tail.then(() => next);
      return acquired;
    },

    async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
      const release = await this.acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
