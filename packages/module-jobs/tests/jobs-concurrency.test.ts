import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/concurrency";
import { canonicalSourceId } from "../src/browser-scrape";
import { httpGet } from "../src/http";

describe("mapLimit", () => {
  test("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:0"]);
  });

  test("never exceeds the concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("one rejection yields null in its slot without losing the batch", async () => {
    const out = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("detail page 404");
      return n * 10;
    });
    expect(out).toEqual([10, null, 30]);
  });

  test("handles an empty input", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  test("a limit below 1 still makes progress", async () => {
    expect(await mapLimit([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});

describe("canonicalSourceId", () => {
  // The HTTP adapter keys Dice rows on the bare UUID while the browser pass
  // saw the relative href, so a unified `scrape --all --browser` inserted the
  // same posting twice under two different keys.
  test("dice collapses to the bare job UUID", () => {
    const uuid = "c6e92bde-222c-4260-b14e-c2c845da7e4e";
    expect(canonicalSourceId("dice", `/job-detail/${uuid}`, "Acme", "Eng")).toBe(uuid);
    expect(canonicalSourceId("dice", `https://www.dice.com/job-detail/${uuid}`, "Acme", "Eng")).toBe(uuid);
  });

  test("other boards get an absolute URL", () => {
    expect(canonicalSourceId("nodesk", "/remote-jobs/acme-engineer/", "Acme", "Eng")).toBe(
      "https://nodesk.co/remote-jobs/acme-engineer/"
    );
    expect(canonicalSourceId("builtin", "https://builtin.com/job/x/1", "Acme", "Eng")).toBe(
      "https://builtin.com/job/x/1"
    );
  });

  test("falls back to company+title when there is no href", () => {
    expect(canonicalSourceId("builtin", undefined, "Acme", "Eng")).toBe("Acme-Eng");
  });
});

describe("per-domain rate limiting under concurrency", () => {
  test("concurrent requests to one domain are spaced, not bursted", async () => {
    // Detail enrichment fires requests concurrently. The old read-sleep-write
    // limiter let every worker observe the same timestamp and wake together,
    // so `rateLimit: 250` produced a burst of N simultaneous requests.
    const hits: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      hits.push(Date.now());
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const spacing = 60;
      const start = Date.now();
      await mapLimit([1, 2, 3, 4], 4, () =>
        httpGet("https://rate-limit.test/page", { rateLimit: spacing, retries: 0 })
      );

      expect(hits).toHaveLength(4);
      hits.sort((a, b) => a - b);

      // Allow generous slack for timer jitter, but a true burst (all four
      // within a few ms) must not pass.
      const total = hits[hits.length - 1] - start;
      expect(total).toBeGreaterThanOrEqual(spacing * 2);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i] - hits[i - 1]).toBeGreaterThanOrEqual(spacing * 0.5);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
