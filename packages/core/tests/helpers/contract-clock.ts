import { setImmediate as nextTurn } from "node:timers/promises";

/**
 * Private clock for in-memory conformance counterexamples only. A native turn
 * drains the callback's real promise continuations before the next timer fires;
 * this is not a clock for IO, child processes or opaque provider runtimes.
 * Each contract case owns its pending timers, including malformed leftovers.
 */
export async function withContractClock<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = [
    [globalThis, "setTimeout"],
    [globalThis, "clearTimeout"],
    [performance, "now"],
  ].map(([owner, key]) => ({
    owner: owner as object,
    key: key as string,
    descriptor: Object.getOwnPropertyDescriptor(owner, key as string),
  }));
  const pending = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let serial = 0;
  const replace = (owner: object, key: string, value: unknown) =>
    Object.defineProperty(owner, key, { configurable: true, writable: true, value });

  try {
    replace(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
      const id = ++serial;
      pending.set(id, { at: now + Math.max(0, ms), callback: () => callback(...args) });
      return id;
    });
    replace(globalThis, "clearTimeout", (id: number) => pending.delete(id));
    replace(performance, "now", () => now);

    let settled = false;
    // Observe rejection immediately and preserve its original error, including
    // assertions thrown by the caller. Driver failures below remain distinct.
    const result = Promise.resolve().then(run).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ).finally(() => { settled = true; });
    for (let deliveries = 0; ; deliveries++) {
      await nextTurn();
      if (settled) {
        const outcome = await result;
        if ("error" in outcome) throw outcome.error;
        return outcome.value;
      }
      if (deliveries >= 1_000) throw new Error("contract clock exceeded its callback budget");
      // Stable sort preserves registration order for equal deadlines. Deliver
      // one callback, then drain promises (including cancellation) before ties.
      const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error("contract clock stalled without a pending timer");
      const [id, timer] = next;
      pending.delete(id);
      now = timer.at;
      timer.callback();
    }
  } finally {
    pending.clear();
    for (const { owner, key, descriptor } of saved) {
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else Reflect.deleteProperty(owner, key);
    }
  }
}
