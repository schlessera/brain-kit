/**
 * Keyed advisory lock — serializes tool executions that contend on the SAME
 * resource, and only those. The old single global mutex (`write-lock.ts`)
 * serialized every mutating tool across every session, which under agent
 * fan-outs degraded a multi-session host into a single-session one: one long
 * Bash held the lock for its whole execution while every other writer's
 * PreToolUse hook stalled past the CLI's hook timeout and had its tool call
 * refused.
 *
 * Keys partition the contention domains instead:
 *
 * - `path:<abs>` — one key per file, for tools that declare their target path.
 *   Two agents writing different notes never touch each other.
 * - a repo-wide key for git-staging/history commands, where interleaving is
 *   the real hazard (`git add` from one session riding into another's commit).
 * - a key for the brain document tools, whose write+reindex bursts are short.
 *
 * FIFO per key; keys are independent. `acquire` takes an optional bounded
 * wait: on expiry the waiter is removed from the queue and the promise rejects
 * with {@link LockBusyError}, so a caller inside a PreToolUse hook can deny
 * the tool with an actionable "retry" reason instead of stalling into the
 * hook timeout, which refuses the call with a misleading message.
 *
 * In-process only, same as before: one backend instance per deployment covers
 * all its sessions; cross-process writers stay out of scope.
 */

/** A bounded `acquire` gave up waiting. The key stays queued-for by others. */
export class LockBusyError extends Error {
  constructor(
    readonly key: string,
    readonly waitedMs: number
  ) {
    super(`lock "${key}" still busy after ${waitedMs}ms`);
    this.name = "LockBusyError";
  }
}

export interface KeyedLock {
  /** True while ANY key is held (diagnostics only — never poll this). */
  readonly locked: boolean;
  /** Keys currently held (diagnostics only — never poll this). */
  readonly heldKeys: string[];
  /**
   * Acquire the key's FIFO lock; resolves with the release function.
   * With `timeoutMs`, rejects LockBusyError when the wait exceeds it.
   */
  acquire(key: string, opts?: { timeoutMs?: number }): Promise<() => void>;
  /** Run `fn` with the key held; releases on resolve AND reject. */
  withLock<T>(key: string, fn: () => Promise<T> | T, opts?: { timeoutMs?: number }): Promise<T>;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createKeyedLock(): KeyedLock {
  // Invariant: queue[0] is the holder; the rest are waiting in order. A key
  // with no queue is free. Grants happen synchronously inside release/acquire,
  // so a timer callback can never interleave between head-promotion and grant.
  const queues = new Map<string, Waiter[]>();

  function grant(key: string, waiter: Waiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return; // double-release is a no-op
      released = true;
      const queue = queues.get(key);
      if (!queue || queue[0] !== waiter) return; // defensive: never dequeue someone else
      queue.shift();
      if (queue.length === 0) queues.delete(key);
      else grant(key, queue[0]!);
    });
  }

  return {
    get locked() {
      return queues.size > 0;
    },
    get heldKeys() {
      return [...queues.keys()];
    },

    acquire(key: string, opts?: { timeoutMs?: number }): Promise<() => void> {
      return new Promise<() => void>((resolve, reject) => {
        let queue = queues.get(key);
        if (!queue) {
          queue = [];
          queues.set(key, queue);
        }
        const waiter: Waiter = { resolve, reject, timer: null };
        queue.push(waiter);
        if (queue[0] === waiter) {
          grant(key, waiter);
          return;
        }
        const timeoutMs = opts?.timeoutMs;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            // Still waiting (a granted waiter has its timer cleared): leave
            // the queue so the eventual release skips this slot entirely.
            const q = queues.get(key);
            const i = q ? q.indexOf(waiter) : -1;
            if (i > 0) q!.splice(i, 1);
            reject(new LockBusyError(key, timeoutMs));
          }, timeoutMs);
        }
      });
    },

    async withLock<T>(
      key: string,
      fn: () => Promise<T> | T,
      opts?: { timeoutMs?: number }
    ): Promise<T> {
      const release = await this.acquire(key, opts);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
