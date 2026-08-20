/**
 * The HTTP client's contract: it refuses what robots.txt refuses, it paces
 * itself, it retries the things worth retrying, and it identifies itself
 * honestly. No network — `fetch` is stubbed per test.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_USER_AGENT } from "../src/config/env.js";
import { ScrapeClient, parseRetryAfterMs } from "../src/fetch/http.js";
import { RateLimiter, type RateLimiterClock } from "../src/politeness/rate-limit.js";
import { RobotsCache, RobotsDisallowedError } from "../src/politeness/robots.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with a scripted sequence of responses. */
function stubFetch(responses: Array<Response | (() => Response | Promise<Response>)>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return calls;
}

/** A robots cache that answers from a literal body, with no network. */
function robotsFor(body: string): RobotsCache {
  return new RobotsCache({
    async fetcher() {
      return { status: 200, body };
    },
  });
}

/** A clock that records waits instead of taking them. */
function fakeClock(): RateLimiterClock & { waits: number[] } {
  let time = 0;
  return {
    waits: [] as number[],
    now: () => time,
    async sleep(ms: number) {
      (this as any).waits.push(ms);
      time += ms;
    },
  } as RateLimiterClock & { waits: number[] };
}

describe("identity", () => {
  test("sends an honest, identifying User-Agent by default", async () => {
    const calls = stubFetch([new Response("ok")]);
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/x");

    expect(calls[0].headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    // The thing this replaced shipped a spoofed Chrome string as its default.
    expect(calls[0].headers["User-Agent"]).not.toContain("Mozilla");
  });

  test("a per-site User-Agent overrides it for that call only", async () => {
    const calls = stubFetch([new Response("ok"), new Response("ok")]);
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/a", { userAgent: "custom/1.0" });
    await client.get("https://example.com/b");

    expect(calls[0].headers["User-Agent"]).toBe("custom/1.0");
    expect(calls[1].headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });
});

describe("robots.txt enforcement", () => {
  const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

  test("a disallowed URL throws before any request goes out", async () => {
    const calls = stubFetch([new Response("should never be fetched")]);
    const client = new ScrapeClient({ robots: robotsFor(DISALLOW_ALL) });

    await expect(client.get("https://example.com/x")).rejects.toThrow(RobotsDisallowedError);
    expect(calls).toEqual([]);
  });

  test("allowDisallowed is the per-call way through", async () => {
    const calls = stubFetch([new Response("ok")]);
    const client = new ScrapeClient({ robots: robotsFor(DISALLOW_ALL) });

    const res = await client.get("https://example.com/x", { allowDisallowed: true });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("respectRobots:false disables the check entirely", async () => {
    stubFetch([new Response("ok")]);
    const client = new ScrapeClient({ respectRobots: false, robots: robotsFor(DISALLOW_ALL) });
    expect((await client.get("https://example.com/x")).status).toBe(200);
  });

  test("Crawl-delay raises the host's rate-limit floor", async () => {
    stubFetch([new Response("ok")]);
    const clock = fakeClock();
    const client = new ScrapeClient({
      robots: robotsFor("User-agent: *\nCrawl-delay: 7\n"),
      rateLimiter: new RateLimiter({ defaultDelayMs: 100, clock }),
    });

    await client.get("https://example.com/a");
    await client.get("https://example.com/b");

    // 7s from robots.txt, not the client's own 100ms.
    expect(clock.waits).toEqual([7000]);
  });
});

describe("retries", () => {
  test("retries a 429 and honours Retry-After", async () => {
    const calls = stubFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const client = new ScrapeClient({ respectRobots: false });

    const res = await client.get("https://example.com/x", { retryDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("does not retry a 404 — the answer will not change", async () => {
    const calls = stubFetch([() => new Response("gone", { status: 404 })]);
    const client = new ScrapeClient({ respectRobots: false });

    const res = await client.get("https://example.com/x", { retryDelayMs: 1 });

    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  test("gives up after the configured retries, naming the status", async () => {
    stubFetch([() => new Response("boom", { status: 503 })]);
    const client = new ScrapeClient({ respectRobots: false });

    await expect(
      client.get("https://example.com/x", { retries: 2, retryDelayMs: 1 })
    ).rejects.toThrow(/HTTP 503/);
  });

  test("getJson throws on a non-2xx rather than parsing an error page", async () => {
    stubFetch([() => new Response("<html>nope</html>", { status: 403 })]);
    const client = new ScrapeClient({ respectRobots: false });

    await expect(client.getJson("https://example.com/x")).rejects.toThrow(/HTTP 403/);
  });
});

describe("parseRetryAfterMs", () => {
  test("reads seconds, reads HTTP-dates, and caps at a minute", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("3600")).toBe(60_000); // capped
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
    expect(parseRetryAfterMs("0")).toBeNull(); // non-positive is not a delay

    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
});
