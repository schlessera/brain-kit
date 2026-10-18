/** Test-owned capture of the actual automatic boot pass, never a manual tick. */
const key = Symbol.for("brain-kit.fixture.boot-prune");
export function installBootPruneCapture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  if (original && (!("value" in original) || original.value !== undefined || !original.configurable))
    throw Error("BOOT_PRUNE_CAPTURE_SLOT_NOT_EMPTY");
  const owner: { promise: Promise<void> | undefined } = Object.seal({ promise: undefined });
  Object.defineProperty(globalThis, key, { value: owner, configurable: true, enumerable: false, writable: false });
  let promise: Promise<void> | undefined;
  const current = () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!descriptor || descriptor.value !== owner || descriptor.configurable !== true || descriptor.enumerable !== false || descriptor.writable !== false)
      throw Error("BOOT_PRUNE_CAPTURE_OWNER_CHANGED");
    return owner.promise;
  };
  return {
    capture() {
      const actual = current();
      if (!(actual instanceof Promise)) throw Error("BOOT_PRUNE_CAPTURE_MISSING");
      if (promise && actual !== promise) throw Error("BOOT_PRUNE_CAPTURE_PROMISE_CHANGED");
      promise = actual;
    },
    async join() {
      if (!promise || current() !== promise) throw Error("BOOT_PRUNE_CAPTURE_PROMISE_CHANGED");
      await promise;
      if (current() !== promise) throw Error("BOOT_PRUNE_CAPTURE_PROMISE_CHANGED");
    },
    restore() {
      try { const actual = current(); if (promise && actual !== promise) throw Error("BOOT_PRUNE_CAPTURE_PROMISE_CHANGED"); }
      finally { if (original) Object.defineProperty(globalThis, key, original); else if (!Reflect.deleteProperty(globalThis, key)) throw Error("BOOT_PRUNE_CAPTURE_RESTORE_FAILED"); }
    },
  };
}
