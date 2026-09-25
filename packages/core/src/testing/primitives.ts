/**
 * The test-runner surface the core seam contract suites register against.
 *
 * Injected rather than imported, as `@schlessera/brain-ui-sdk/testing` does,
 * so the suites depend on no test runner: pass `{ describe, test, expect }`
 * from `bun:test`, or the same three from any runner whose `expect` throws on
 * a failed match.
 */

interface ContractMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
}

/** The minimal test-runner surface used by the core seam contract suites. */
export interface ContractTestPrimitives {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): ContractMatchers;
}

/**
 * How a promise settled within `ms`: its value, its rejection, or `"pending"`
 * when it did neither. A suite that awaits a provider bare would hang on a
 * provider that never answers; this turns that hang into an assertion.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ state: "resolved"; value: T } | { state: "rejected"; error: unknown } | { state: "pending" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<{ state: "pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error })
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
