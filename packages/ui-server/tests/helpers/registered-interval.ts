/** Test-local host interval control; Date, timeouts and native processes stay real. */
export function registeredInterval() {
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearInterval")!;
  const realClear = globalThis.clearInterval;
  let now = 0, dispatches = 0;
  const registrations: { callback: () => void; delay: number; due: number; handle: ReturnType<typeof setInterval>; cancelled: boolean }[] = [];
  Object.defineProperty(globalThis, "setInterval", { ...setDescriptor, value: (callback: () => void, delay: number) => {
    const handle = { unref() { return this; } } as ReturnType<typeof setInterval>;
    registrations.push({ callback, delay, due: now + delay, handle, cancelled: false });
    return handle;
  } });
  Object.defineProperty(globalThis, "clearInterval", { ...clearDescriptor, value: (handle: ReturnType<typeof setInterval> | undefined) => {
    const registration = registrations.find(item => item.handle === handle);
    if (registration) registration.cancelled = true;
    else realClear(handle);
  } });
  function restore() {
    Object.defineProperty(globalThis, "setInterval", setDescriptor);
    Object.defineProperty(globalThis, "clearInterval", clearDescriptor);
  }
  return {
    registrations,
    get dispatches() { return dispatches; },
    // Only begin's registration is controlled. Subsequent unrelated intervals
    // retain their native scheduler and clearInterval delegates their handles.
    finishRegistration() { Object.defineProperty(globalThis, "setInterval", setDescriptor); },
    advanceTo(deadline: number) {
      if (deadline < now) throw Error("Interval clock cannot go backwards");
      for (;;) {
        const next = registrations.filter(item => !item.cancelled && item.due <= deadline).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        if (!(next.delay > 0)) throw Error("Expected a positive scope observation interval");
        now = next.due; next.due += next.delay; dispatches++; next.callback();
      }
      now = deadline;
    },
    restore,
    async cleanup(actions: readonly (() => unknown | Promise<unknown>)[]) {
      const errors: unknown[] = [];
      try {
        for (const action of actions) {
          try { await action(); } catch (error) { errors.push(error); }
        }
      } finally { restore(); }
      if (errors.length) throw new AggregateError(errors, "Scope fixture cleanup failed");
    },
  };
}
