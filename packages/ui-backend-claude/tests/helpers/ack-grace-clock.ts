/** Test-local ownership of the runner's acknowledgement timer, never the native CLI. */
type Handle = ReturnType<typeof setTimeout>;
type Registration = { delay: number; due: number; fired: boolean; cleared: boolean; callback: () => void };

// Preserve real task/microtask delivery around every logical deadline.
export const nativeTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function ackGraceClock() {
  const descriptors = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!,
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!,
  };
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const registrations: Registration[] = [];
  const handles = new Map<Handle, Registration>();
  let now = 0;
  const schedule = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    // Select the importing owner, not the expected duration: a wrong interval
    // must still be controlled and fail the boundary/registration assertions.
    if (!new Error().stack?.split("\n")[2]?.includes("/src/turn-runner.ts:")) return nativeSet(callback, delay, ...args);
    const registration = { delay: delay ?? 0, due: now + (delay ?? 0), fired: false, cleared: false, callback: () => callback(...args) };
    const handle = {} as Handle;
    registrations.push(registration);
    handles.set(handle, registration);
    return handle;
  }) as typeof setTimeout;
  const cancel = ((handle: Handle | undefined) => {
    const registration = handle === undefined ? undefined : handles.get(handle);
    if (registration) registration.cleared = true;
    else nativeClear(handle);
  }) as typeof clearTimeout;
  Object.defineProperty(globalThis, "setTimeout", { ...descriptors.setTimeout, value: schedule });
  Object.defineProperty(globalThis, "clearTimeout", { ...descriptors.clearTimeout, value: cancel });
  return {
    registrations,
    pending: () => registrations.filter((entry) => !entry.fired && !entry.cleared).length,
    async advance(ms: number) {
      await nativeTurn();
      const target = now + ms;
      while (true) {
        const next = registrations.filter((entry) => !entry.fired && !entry.cleared && entry.due <= target)
          .sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.fired = true;
        next.callback();
        await nativeTurn();
      }
      now = target;
      await nativeTurn();
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", descriptors.setTimeout);
      Object.defineProperty(globalThis, "clearTimeout", descriptors.clearTimeout);
      // Even a missing production clear cannot leak a callback into another test.
      handles.clear();
    },
  };
}
