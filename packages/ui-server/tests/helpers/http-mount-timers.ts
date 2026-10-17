import { spyOn } from "bun:test";

/** Observe real timers, including unref'ed ones Bun's active-resource API omits. */
export function observeMountTimers() {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  const clearTimeoutOriginal = globalThis.clearTimeout, clearIntervalOriginal = globalThis.clearInterval;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = timeout((...values: unknown[]) => { pending.delete(handle); callback(...values); }, delay, ...args);
    // Bun's Node HTTP agent cancels this one timer through a captured native
    // clear reference. Its fixture-owned socket close is joined and asserted
    // separately. Unknown origins (including SDK timers) remain in the ledger.
    const stack = new Error().stack ?? "";
    const nodeKeepalive = stack.includes("at keepSocketAlive (node:_http_agent:") && stack.includes("at setTimeout (node:net:");
    if (!nodeKeepalive) pending.add(handle);
    return handle;
  }) as typeof setTimeout);
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const handle = interval(...args);
    pending.add(handle);
    return handle;
  }) as typeof setInterval);
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    pending.delete(handle as ReturnType<typeof setTimeout>);
    Reflect.apply(clearTimeoutOriginal, globalThis, [handle]);
  });
  const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
    pending.delete(handle as ReturnType<typeof setTimeout>);
    Reflect.apply(clearIntervalOriginal, globalThis, [handle]);
  });
  return { pending, restore() {
    timeoutSpy.mockRestore(); intervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore(); clearIntervalSpy.mockRestore();
  } };
}
