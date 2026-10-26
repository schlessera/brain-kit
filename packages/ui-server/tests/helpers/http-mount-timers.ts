import { spyOn } from "bun:test";

/** Observe real timers, including unref'ed ones Bun's active-resource API omits. */
export function observeMountTimers() {
  const observed = new Set<ReturnType<typeof setTimeout>>();
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const handle = Reflect.apply(timeout, globalThis, args);
    observed.add(handle);
    return handle;
  }) as typeof setTimeout);
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const handle = Reflect.apply(interval, globalThis, args);
    observed.add(handle);
    return handle;
  }) as typeof setInterval);
  return {
    get pending() {
      // Bun 1.4.2's native Timeout getter reports cancellation even when an
      // imported clear function, close() or socket destruction bypasses a
      // global clear spy. Keep unknown states observed. Retain every handle
      // so refresh() can reactivate a fired timeout. No owner,
      // stack, ref state or delay exempts a live timer (including keepalive).
      return new Set([...observed].filter(handle =>
        (handle as unknown as { readonly _destroyed?: boolean })._destroyed !== true));
    },
    restore() {
      timeoutSpy.mockRestore(); intervalSpy.mockRestore();
      Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
      Object.defineProperty(globalThis, "setInterval", intervalDescriptor);
    },
  };
}
