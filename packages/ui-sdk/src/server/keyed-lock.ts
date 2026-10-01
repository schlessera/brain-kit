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
 * FIFO within each priority; interactive waiters precede autonomous waiters.
 * Keys are independent. `acquire` takes an optional bounded
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

export interface KeyedLockAcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Unannotated callers remain interactive. */
  priority?: "interactive" | "autonomous";
  /** Cooperative notification only: the holder must checkpoint and unwind.
   * The lock is never forcibly released while its body can still write. */
  onYield?: (key: string) => void;
  yieldAfterMs?: number;
}

export interface KeyedLock {
  /** True while ANY key is held (diagnostics only — never poll this). */
  readonly locked: boolean;
  /** Keys currently held (diagnostics only — never poll this). */
  readonly heldKeys: string[];
  /**
   * Acquire the key's priority/FIFO lock; resolves with the release function.
   * With `timeoutMs`, rejects LockBusyError when the wait exceeds it.
   */
  acquire(key: string, opts?: KeyedLockAcquireOptions): Promise<() => void>;
  /** Run `fn` with the key held; releases on resolve AND reject. */
  withLock<T>(key: string, fn: () => Promise<T> | T, opts?: KeyedLockAcquireOptions): Promise<T>;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  opts: KeyedLockAcquireOptions;
  queuedAt: number;
  removeAbort?: () => void;
  yielded: boolean;
}

export function createKeyedLock(clock: {
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}): KeyedLock {
  const now = clock.now ?? Date.now;
  const schedule = clock.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms) as ReturnType<typeof setTimeout>);
  const unschedule = clock.clearTimeout ?? clearTimeout;
  // Invariant: queue[0] is the holder; the rest are waiting in order. A key
  // with no queue is free. Grants happen synchronously inside release/acquire,
  // so a timer callback can never interleave between head-promotion and grant.
  const queues = new Map<string, Waiter[]>();
  const yieldTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function refreshYield(key: string): void {
    const timer = yieldTimers.get(key);
    if (timer !== undefined) { unschedule(timer); yieldTimers.delete(key); }
    const queue = queues.get(key), holder = queue?.[0];
    if (!holder || holder.opts.priority !== "autonomous" || !holder.opts.onYield || holder.yielded) return;
    const interactive = queue!.slice(1).find((waiter) => waiter.opts.priority !== "autonomous");
    if (!interactive) return;
    const delay = Math.max(0, interactive.queuedAt + (holder.opts.yieldAfterMs ?? 20_000) - now());
    yieldTimers.set(key, schedule(() => {
      yieldTimers.delete(key);
      // Cancel/removal always refreshes this timer; keep a defensive ownership check.
      if (queues.get(key)?.[0] !== holder || holder.yielded) return;
      holder.yielded = true;
      holder.opts.onYield!(key);
    }, delay));
  }

  function clean(waiter: Waiter): void {
    if (waiter.timer !== null) { unschedule(waiter.timer); waiter.timer = null; }
    waiter.removeAbort?.(); waiter.removeAbort = undefined;
  }

  function grant(key: string, waiter: Waiter): void {
    clean(waiter);
    let released = false;
    waiter.resolve(() => {
      if (released) return; // double-release is a no-op
      released = true;
      const queue = queues.get(key);
      if (!queue || queue[0] !== waiter) return; // defensive: never dequeue someone else
      queue.shift();
      if (queue.length === 0) queues.delete(key);
      else grant(key, queue[0]!);
      refreshYield(key);
    });
    refreshYield(key);
  }

  return {
    get locked() {
      return queues.size > 0;
    },
    get heldKeys() {
      return [...queues.keys()];
    },

    acquire(key: string, opts: KeyedLockAcquireOptions = {}): Promise<() => void> {
      return new Promise<() => void>((resolve, reject) => {
        if (opts.signal?.aborted) { reject(new DOMException("Lock wait cancelled", "AbortError")); return; }
        if (opts.yieldAfterMs !== undefined && (!Number.isFinite(opts.yieldAfterMs) || opts.yieldAfterMs <= 0)) {
          reject(new Error("Lock yield threshold must be positive")); return;
        }
        let queue = queues.get(key);
        if (!queue) {
          queue = [];
          queues.set(key, queue);
        }
        const waiter: Waiter = { resolve, reject, timer: null, opts: { ...opts }, queuedAt: now(), yielded: false };
        const firstAutonomous = opts.priority === "autonomous" ? -1 : queue.findIndex((entry, i) => i > 0 && entry.opts.priority === "autonomous");
        if (firstAutonomous < 0) queue.push(waiter);
        else queue.splice(firstAutonomous, 0, waiter);
        if (queue[0] === waiter) {
          grant(key, waiter);
          return;
        }
        const remove = (error: Error): void => {
          const q = queues.get(key), i = q ? q.indexOf(waiter) : -1;
          if (i <= 0) return;
          q!.splice(i, 1); clean(waiter); refreshYield(key); reject(error);
        };
        if (opts.signal) {
          const onAbort = () => remove(new DOMException("Lock wait cancelled", "AbortError"));
          opts.signal.addEventListener("abort", onAbort, { once: true });
          waiter.removeAbort = () => opts.signal!.removeEventListener("abort", onAbort);
        }
        const timeoutMs = opts.timeoutMs;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          waiter.timer = schedule(() => {
            // Still waiting (a granted waiter has its timer cleared): leave
            // the queue so the eventual release skips this slot entirely.
            remove(new LockBusyError(key, timeoutMs));
          }, timeoutMs);
        }
        refreshYield(key);
      });
    },

    async withLock<T>(
      key: string,
      fn: () => Promise<T> | T,
      opts?: KeyedLockAcquireOptions
    ): Promise<T> {
      const release = await this.acquire(key, opts);
      try {
        if (opts?.signal?.aborted) throw new DOMException("Lock work cancelled", "AbortError");
        return await fn();
      } finally {
        release();
      }
    },
  };
}
