/** Drive only cleanup's slow timers; filesystem/worker/test deadlines stay real. */
export function cleanupTimers(delay = 30_000) {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const pending = new Map<object, () => void>();
  const handles: { unrefed: boolean }[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== delay) return set(callback, ms, ...args);
    const handle = { unrefed: false, unref() { this.unrefed = true; return this; } };
    handles.push(handle);
    pending.set(handle, () => callback(...args));
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (handles.includes(handle as unknown as { unrefed: boolean })) pending.delete(handle);
    else clear(handle);
  }) as typeof clearTimeout;
  return {
    pending, handles,
    fire() {
      for (const [handle, callback] of [...pending]) {
        if (!pending.delete(handle)) continue;
        callback();
      }
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
      Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
    },
  };
}
