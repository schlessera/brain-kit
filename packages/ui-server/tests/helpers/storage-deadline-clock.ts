import { STORAGE_SETTLEMENT_MS } from "../../src/db/settlement.js";

/**
 * Advance only the production storage budget; native I/O remains genuinely held.
 *
 * By default a registered budget still fires after its real interval. With
 * `manual`, it fires only through `expire()` or `captureLatest()`. That suits a
 * test whose claim is not the budget, but whose held writes take a
 * load-dependent time to settle, so a slow host cannot expire them (#3561).
 */
export function storageDeadlineClock(options: { manual?: boolean } = {}) {
  const timeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const clear = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  let registered = 0;
  Object.defineProperty(globalThis, "setTimeout", { ...timeout, value: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== STORAGE_SETTLEMENT_MS) return nativeSet(callback, ms, ...args);
    registered++;
    // A manual budget keeps a real handle, so clearTimeout behaves natively, but its expiry does nothing.
    const timer = options.manual ? nativeSet(() => {}, ms) : nativeSet(() => { pending.delete(timer); callback(...args); }, ms);
    pending.set(timer, () => callback(...args));
    return timer;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { ...clear, value: (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); nativeClear(timer); } });
  return {
    get pending() { return pending.size; },
    /** Every production budget armed since installation, settled or not. */
    get registered() { return registered; },
    /** Capture one concrete deadline; cancellation must not expire a different timer. */
    captureLatest() {
      const timer = [...pending.keys()].at(-1);
      if (timer === undefined) throw Error("No storage deadline was registered");
      return () => {
        const callback = pending.get(timer);
        if (callback) { pending.delete(timer); nativeClear(timer); callback(); }
      };
    },
    expire() { for (const [timer, callback] of [...pending]) { pending.delete(timer); nativeClear(timer); callback(); } },
    restore() { for (const timer of pending.keys()) nativeClear(timer); pending.clear(); Object.defineProperty(globalThis, "setTimeout", timeout); Object.defineProperty(globalThis, "clearTimeout", clear); },
  };
}
