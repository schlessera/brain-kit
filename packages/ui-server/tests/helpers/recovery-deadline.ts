/** Only the stalled-recovery fixture installs this clock. Date, intervals and
 * native promise/SQLite work stay real; no production duration is substituted.
 */
export function recoveryDeadline() {
  const names = ["setTimeout", "clearTimeout"] as const;
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)!);
  const nativeClear = globalThis.clearTimeout;
  let now = 0;
  const registrations: {
    delay: number; due: number; callback: () => void;
    handle: ReturnType<typeof setTimeout>; fired: boolean; cleared: boolean;
  }[] = [];
  Object.defineProperty(globalThis, "setTimeout", { ...descriptors[0], value: (callback: () => void, delay: number) => {
    // Recovery only passes this opaque handle to clearTimeout.
    const handle = {} as ReturnType<typeof setTimeout>;
    registrations.push({ delay, due: now + delay, callback, handle, fired: false, cleared: false });
    return handle;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { ...descriptors[1], value: (handle: ReturnType<typeof setTimeout> | undefined) => {
    const timer = registrations.find(item => item.handle === handle);
    if (timer) timer.cleared = true;
    else nativeClear(handle);
  } });
  return {
    descriptors,
    registrations,
    pending: () => registrations.filter(timer => !timer.fired && !timer.cleared),
    advanceTo(deadline: number) {
      if (deadline < now) throw Error("Recovery clock cannot go backwards");
      for (const timer of registrations.filter(timer => !timer.fired && !timer.cleared && timer.due <= deadline).sort((a, b) => a.due - b.due)) {
        now = timer.due;
        timer.fired = true;
        timer.callback();
      }
      now = deadline;
    },
    restore() {
      for (let i = 0; i < names.length; i++) Object.defineProperty(globalThis, names[i]!, descriptors[i]!);
      // A failed assertion can leave owned callbacks pending. Retire them without
      // delivering a rejection into a later test.
      registrations.length = 0;
    },
  };
}
