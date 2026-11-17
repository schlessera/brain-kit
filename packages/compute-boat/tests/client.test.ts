/**
 * The transport reads an error answer only up to a bound: a vendor error is
 * a small JSON envelope, and a runaway body must not be held in memory.
 */

import { describe, expect, test } from "bun:test";

import { call } from "../src/client";

const BOUND = 64 * 1024;
import { createRedactor } from "../src/redact";
import { KEY } from "./helpers/context";

function streaming(status: number, total: number) {
  let pulled = 0;
  const chunk = new Uint8Array(16 * 1024).fill(0x61);
  const fetchFn = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= total) return controller.close();
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { status, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
  return { fetchFn, pulled: () => pulled };
}

describe("error bodies", () => {
  test("an error answer is read only up to the bound", async () => {
    const { fetchFn, pulled } = streaming(400, 32 * 1024 * 1024);
    const ctx = {
      instanceId: "boat-small",
      options: {},
      secret: KEY,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      fetch: fetchFn,
      log: { debug() {}, warn() {} },
    };
    const r = await call(ctx, { method: "GET", path: "/limits", label: "GET /limits", retry: "none" }, createRedactor(KEY), { now: Date.now, sleep: async () => {} });
    expect(r.last.kind === "response" && r.last.status).toBe(400);
    expect(r.last.kind === "response" && r.last.body).toBeUndefined();
    expect(pulled()).toBeLessThanOrEqual(BOUND + 64 * 1024);
  });
});
