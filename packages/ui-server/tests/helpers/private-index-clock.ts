/** Own only private-index cache time; native IO and test deadlines keep running. */
export function privateIndexClock() {
  const saved = [
    [globalThis, "setTimeout"], [globalThis, "clearTimeout"], [Date, "now"],
  ].map(([owner, key]) => ({ owner: owner as object, key: key as string,
    descriptor: Object.getOwnPropertyDescriptor(owner, key as string)! }));
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, nativeNow = Date.now;
  type Handle = ReturnType<typeof setTimeout>;
  const pending = new Map<Handle, { due: number; callback: () => void }>();
  let now = Date.parse("2026-07-12T00:00:00Z"), registrations = 0;
  // Match the caller, never its requested delay: a policy mutation must fail.
  const owned = () => new Error().stack?.split("\n")[3]?.includes("/src/brain/private-index-cache.ts:");
  const schedule = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    if (!owned()) return nativeSet(callback, delay, ...args);
    if (++registrations > 32) throw new Error("private-index timer registration budget exceeded");
    const handle = {} as Handle;
    pending.set(handle, { due: now + delay, callback: () => callback(...args) });
    return handle;
  }) as typeof setTimeout;
  const cancel = ((handle: Handle | undefined) => {
    if (handle === undefined || !pending.delete(handle)) nativeClear(handle);
  }) as typeof clearTimeout;
  Object.defineProperty(globalThis, "setTimeout", { ...saved[0]!.descriptor, value: schedule });
  Object.defineProperty(globalThis, "clearTimeout", { ...saved[1]!.descriptor, value: cancel });
  Object.defineProperty(Date, "now", { ...saved[2]!.descriptor, value: () => owned() ? now : nativeNow() });
  return {
    deadlines: () => [...pending.values()].map(timer => timer.due).sort((a, b) => a - b),
    get now() { return now; },
    async advance(ms: number) {
      const target = now + ms;
      for (let delivered = 0; ; delivered++) {
        const next = [...pending].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        if (delivered >= 32) throw new Error("private-index timer delivery budget exceeded");
        const [handle, timer] = next;
        now = timer.due;
        pending.delete(handle);
        timer.callback();
        // Fixture checkpoint release is synchronous; drain trim's promise chain
        // before delivering another callback or inspecting its released views.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      now = target;
    },
    restore() {
      pending.clear();
      for (const { owner, key, descriptor } of saved) Object.defineProperty(owner, key, descriptor);
    },
  };
}
