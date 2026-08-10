import { describe, expect, test } from "bun:test";

import { classifyError, withRetry } from "../src/lib/llm-util";

/** No-op sleep + onRetry so retry tests run instantly and quietly. */
const fast = { sleep: async () => {}, onRetry: () => {} };

describe("classifyError", () => {
  test("429 status → rate-limit", () => {
    expect(classifyError({ status: 429 })).toBe("rate-limit");
  });
  test("RESOURCE_EXHAUSTED message → rate-limit", () => {
    expect(classifyError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe("rate-limit");
  });
  test("5xx status → transient", () => {
    expect(classifyError({ status: 503 })).toBe("transient");
  });
  test("network error message → transient", () => {
    expect(classifyError(new Error("fetch failed"))).toBe("transient");
    expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
  });
  test("anything else → fatal", () => {
    expect(classifyError(new Error("bad request: 400"))).toBe("fatal");
    expect(classifyError("nope")).toBe("fatal");
  });
});

describe("withRetry", () => {
  test("retries transient failures then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("fetch failed");
      return "ok";
    }, fast);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("fatal errors throw immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("400 bad request");
      }, fast)
    ).rejects.toThrow("400 bad request");
    expect(calls).toBe(1);
  });

  test("gives up after maxRetries attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("503 unavailable");
      }, fast)
    ).rejects.toThrow("503");
    expect(calls).toBe(5); // MAX_RETRIES
  });

  test("uses the documented exponential backoff curve", async () => {
    const delays: number[] = [];
    await expect(
      withRetry(async () => {
        throw new Error("fetch failed"); // transient → base 1000
      }, { sleep: async () => {}, onRetry: ({ delayMs }) => delays.push(delayMs) })
    ).rejects.toThrow();
    // 4 backoffs before the 5th (final) attempt throws.
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  test("rate-limit backoff starts from the longer base", async () => {
    const delays: number[] = [];
    await expect(
      withRetry(async () => {
        throw new Error("429 too many requests");
      }, { sleep: async () => {}, onRetry: ({ delayMs }) => delays.push(delayMs) })
    ).rejects.toThrow();
    expect(delays).toEqual([4000, 8000, 16000, 32000]);
  });
});
