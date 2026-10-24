import { expect } from "bun:test";

/**
 * `await expect(promise).rejects.toThrow(expected)` for a promise that waits
 * on the SQLite write worker (#2814). Bun 1.4.2's `expect().rejects` and
 * `.resolves` wait in a nested event loop that does not deliver the worker's
 * reply, so such an assertion never settles. This awaits normally, then applies
 * the same `toThrow` matcher.
 */
export async function expectRejection(promise: PromiseLike<unknown> | unknown, expected?: string | RegExp | Error | (abstract new (...args: never[]) => Error), label?: string): Promise<unknown> {
  const outcome = await Promise.resolve(promise).then(value => ({ resolved: true as const, value }), (error: unknown) => ({ resolved: false as const, error }));
  if (outcome.resolved) throw new Error(`${label ? `${label}: ` : ""}expected a rejection, but the promise resolved`);
  const thrower = () => { throw outcome.error; };
  if (expected === undefined) expect(thrower, label).toThrow();
  else expect(thrower, label).toThrow(expected as never);
  return outcome.error;
}

/** The rejection reason, for `expect(promise).rejects.<matcher>` assertions other than `toThrow`. */
export async function rejection(promise: PromiseLike<unknown> | unknown, label?: string): Promise<unknown> {
  const outcome = await Promise.resolve(promise).then(value => ({ resolved: true as const, value }), (error: unknown) => ({ resolved: false as const, error }));
  if (outcome.resolved) throw new Error(`${label ? `${label}: ` : ""}expected a rejection, but the promise resolved`);
  return outcome.error;
}
