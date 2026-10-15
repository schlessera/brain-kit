import { expect } from "bun:test";

/** Yield to native callbacks before asserting; Bun's promise matchers poll synchronously. */
export async function expectAsyncRejection(operation: Promise<unknown>, message: string): Promise<void> {
  let rethrow: (() => never) | undefined;
  try {
    await operation;
  } catch (error) {
    rethrow = () => { throw error; };
  }
  // A fulfilled operation leaves a non-throwing callback and fails this assertion.
  expect(rethrow ?? (() => {})).toThrow(message);
}
