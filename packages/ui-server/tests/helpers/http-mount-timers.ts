import { spyOn } from "bun:test";
import { globalAgent } from "node:http";

/** Observe real timers, including unref'ed ones Bun's active-resource API omits. */
export function observeMountTimers() {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  const clearTimeoutOriginal = globalThis.clearTimeout, clearIntervalOriginal = globalThis.clearInterval;
  const keepaliveDescriptor = Object.getOwnPropertyDescriptor(globalAgent, "keepSocketAlive");
  const keepalive = globalAgent.keepSocketAlive;
  let inKeepalive = false;
  // This owner's native timer may bypass the global clear observer. Fixture
  // socket close is joined and asserted separately; identify its actual call
  // instead of depending on optional/formatted Error.stack frames.
  Object.defineProperty(globalAgent, "keepSocketAlive", {
    configurable: true, writable: true,
    value: function (this: typeof globalAgent, ...args: Parameters<typeof keepalive>) {
      const previous = inKeepalive;
      inKeepalive = true;
      try { return Reflect.apply(keepalive, this, args); }
      finally { inKeepalive = previous; }
    },
  });
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = timeout((...values: unknown[]) => { pending.delete(handle); callback(...values); }, delay, ...args);
    // Unknown origins (including SDK and other socket timers) remain observed.
    if (!inKeepalive) pending.add(handle);
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
    if (keepaliveDescriptor) Object.defineProperty(globalAgent, "keepSocketAlive", keepaliveDescriptor);
    else Reflect.deleteProperty(globalAgent, "keepSocketAlive");
  } };
}
