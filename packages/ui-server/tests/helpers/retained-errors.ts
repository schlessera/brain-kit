import { spyOn } from "bun:test";

/** Observe the existing Set insertion boundary, including errors hidden by a close-time slice. */
export function watchRetainedErrors(errors: Error[]) {
  let peak = 0;
  const add = Set.prototype.add;
  const spy = spyOn(Set.prototype, "add").mockImplementation(function<T>(this: Set<T>, value: T) {
    const result = add.call(this, value);
    if (errors.includes(value as Error)) peak = Math.max(peak, this.size);
    return result;
  });
  return { peak: () => peak, restore: () => spy.mockRestore() };
}
