/** The activity store's write methods and one caller's ordered write queue (#2814, #4818). */
import type { ActivityWriteMethod, AwaitableActivityStore } from "./store.js";

export const ACTIVITY_WRITE_METHODS = ["writeClientReceipt", "writeLifecycle", "startSpan", "endSpan", "patchSpan", "appendEvent", "heartbeat",
  "cascadeClose", "sweepOwnOrphans", "sweepStale", "rollupRun", "prune"] as const satisfies readonly ActivityWriteMethod[];

/**
 * One caller's writes as a queue. Each write is submitted once every earlier
 * one has committed, and `after(job)` runs a read or a notification at its
 * place in that order, so it sees every write queued before it. Over a
 * synchronous store, or while nothing is pending, a call runs at once, as it
 * always did. A failed write or job is reported and dropped, as a synchronous
 * failure was. A caller that writes inside its own transaction awaits
 * `settled()` first, so those writes run now, inside it.
 */
export function orderedWrites<S extends Partial<AwaitableActivityStore>>(store: S, failed: (error: unknown) => void): {
  store: S; after(job: () => unknown): void; settled(): Promise<void>;
} {
  let pending = 0, tail: Promise<void> = Promise.resolve();
  const run = (job: () => unknown): Promise<void> | undefined => {
    try {
      const result = job();
      if (result instanceof Promise) return result.then(() => {}, failed);
    } catch (error) { failed(error); }
    return undefined;
  };
  const after = (job: () => unknown) => {
    if (pending === 0) {
      const running = run(job);
      if (!running) return;
      pending++; tail = running.finally(() => { pending--; });
      return;
    }
    pending++; tail = tail.then(() => run(job)).finally(() => { pending--; });
  };
  const view = Object.create(store) as S;
  for (const name of ACTIVITY_WRITE_METHODS) {
    if (typeof store[name] !== "function") continue;
    Object.defineProperty(view, name, { enumerable: true, value: (...args: unknown[]) => {
      after(() => Reflect.apply(store[name] as (...values: unknown[]) => unknown, store, args));
    } });
  }
  return { store: view, after, settled: async () => { let waiting: Promise<void>; do { waiting = tail; await waiting; } while (waiting !== tail); } };
}
