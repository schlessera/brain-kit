/** Restore complete descriptors even when a regression mutates inherited model keys. */
export async function withPrototypeGuard<T>(run: () => T | Promise<T>): Promise<T> {
  const targets = [Object.prototype, Object, Object.prototype.toString];
  const snapshots = targets.map(target => Object.getOwnPropertyDescriptors(target));
  try { return await run(); }
  finally {
    for (const [index, target] of targets.entries()) {
      const saved = snapshots[index]!;
      for (const key of Reflect.ownKeys(target)) if (!Object.hasOwn(saved, key)) Reflect.deleteProperty(target, key);
      Object.defineProperties(target, saved);
    }
  }
}
