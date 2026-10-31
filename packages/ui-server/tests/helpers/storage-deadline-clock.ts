import { STORAGE_SETTLEMENT_MS } from "../../src/db/settlement.js";

/** Advance only the production storage budget; native I/O remains genuinely held. */
export function storageDeadlineClock() {
  const timeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const clear = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  Object.defineProperty(globalThis, "setTimeout", { ...timeout, value: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== STORAGE_SETTLEMENT_MS) return nativeSet(callback, ms, ...args);
    const timer = nativeSet(() => { pending.delete(timer); callback(...args); }, ms);
    pending.set(timer, () => callback(...args));
    return timer;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { ...clear, value: (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); nativeClear(timer); } });
  return {
    get pending() { return pending.size; },
    expire() { for (const [timer, callback] of [...pending]) { pending.delete(timer); nativeClear(timer); callback(); } },
    restore() { for (const timer of pending.keys()) nativeClear(timer); pending.clear(); Object.defineProperty(globalThis, "setTimeout", timeout); Object.defineProperty(globalThis, "clearTimeout", clear); },
  };
}
