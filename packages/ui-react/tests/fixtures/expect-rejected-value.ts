import { expect } from "bun:test";

/** Await browser work before matching: Bun's promise matchers pump a nested event loop (#1993). */
export async function expectRejectedValue(operation: Promise<unknown>, expected: Error): Promise<void> {
  let rejected: unknown;
  try {
    await operation;
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBe(expected);
}
