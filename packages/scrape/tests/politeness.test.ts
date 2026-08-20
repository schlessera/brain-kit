/**
 * The politeness layer is the part of this package with an outside party, so
 * it is the part that has to be provably right. Nothing here touches the
 * network: the rate limiter takes an injected clock, and the robots cache
 * takes an injected fetcher.
 */
import { describe, expect, test } from "bun:test";

import { RateLimiter, hostOf, type RateLimiterClock } from "../src/politeness/rate-limit.js";
import { RobotsCache, RobotsDisallowedError } from "../src/politeness/robots.js";

/** A clock that never really sleeps, and records what it was asked to wait. */
function fakeClock(): RateLimiterClock & { waits: number[]; time: number } {
  const clock = {
    time: 1_000_000,
    waits: [] as number[],
    now() {
      return clock.time;
    },
    async sleep(ms: number) {
      clock.waits.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

describe("RateLimiter", () => {
  test("spaces requests to one host and leaves other hosts alone", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ defaultDelayMs: 1000, clock });

    await limiter.acquire("a.example");
    expect(clock.waits).toEqual([]); // first request never waits

    await limiter.acquire("b.example");
    expect(clock.waits).toEqual([]); // a different host is unaffected

    await limiter.acquire("a.example");
    expect(clock.waits).toEqual([1000]);
  });

  test("waits only the remaining time, not the full delay", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ defaultDelayMs: 1000, clock });

    await limiter.acquire("a.example");
    clock.time += 600; // 600ms of real work happened in between
    await limiter.acquire("a.example");

    expect(clock.waits).toEqual([400]);
  });

  test("a per-call delay raises the floor but never lowers it", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ defaultDelayMs: 1000, clock });

    await limiter.acquire("a.example");
    await limiter.acquire("a.example", 5000); // crawl-delay style override
    expect(clock.waits).toEqual([5000]);

    clock.waits.length = 0;
    await limiter.acquire("a.example", 10); // below the default
    expect(clock.waits).toEqual([1000]); // the default still applies
  });

  test("two limiters do not throttle each other", async () => {
    // The regression this class exists for: the version it replaces kept its
    // clock in a module-level Map shared by every caller in the process.
    const clock = fakeClock();
    const one = new RateLimiter({ defaultDelayMs: 1000, clock });
    const two = new RateLimiter({ defaultDelayMs: 1000, clock });

    await one.acquire("a.example");
    await two.acquire("a.example");

    expect(clock.waits).toEqual([]);
  });

  test("hostOf extracts a hostname and tolerates junk", () => {
    expect(hostOf("https://example.com/a/b?c=d")).toBe("example.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

const ROBOTS = `
User-agent: *
Disallow: /private
Allow: /private/public-bit
Crawl-delay: 3

User-agent: brain-scrape
Disallow: /just-for-us
`;

function cache(
  responses: Record<string, { status: number; body: string }>,
  counter?: { calls: string[] }
) {
  return new RobotsCache({
    async fetcher(url) {
      counter?.calls.push(url);
      return responses[url] ?? { status: 404, body: "" };
    },
  });
}

describe("RobotsCache", () => {
  test("honours Disallow, the Allow override, and per-agent groups", async () => {
    const robots = cache({
      "https://example.com/robots.txt": { status: 200, body: ROBOTS },
    });
    const rules = await robots.forUrl("https://example.com/anything");

    expect(rules.loaded).toBe(true);
    expect(rules.isAllowed("https://example.com/private/x", "some-bot")).toBe(false);
    expect(rules.isAllowed("https://example.com/private/public-bit", "some-bot")).toBe(true);
    // Our own group replaces the wildcard group rather than adding to it.
    expect(rules.isAllowed("https://example.com/private/x", "brain-scrape")).toBe(true);
    expect(rules.isAllowed("https://example.com/just-for-us", "brain-scrape")).toBe(false);
  });

  test("reads Crawl-delay in milliseconds", async () => {
    const robots = cache({
      "https://example.com/robots.txt": { status: 200, body: ROBOTS },
    });
    const rules = await robots.forUrl("https://example.com/");
    expect(rules.crawlDelayMs("some-bot")).toBe(3000);
    expect(rules.crawlDelayMs("brain-scrape")).toBeUndefined();
  });

  test("fetches robots.txt once per origin, even under concurrency", async () => {
    const counter = { calls: [] as string[] };
    const robots = cache(
      { "https://example.com/robots.txt": { status: 200, body: ROBOTS } },
      counter
    );

    await Promise.all([
      robots.forUrl("https://example.com/a"),
      robots.forUrl("https://example.com/b"),
      robots.forUrl("https://example.com/c"),
    ]);
    await robots.forUrl("https://example.com/d");

    expect(counter.calls).toEqual(["https://example.com/robots.txt"]);
  });

  test("a 404, a 5xx and a thrown fetch all mean no rules, not no access", async () => {
    // Treating an outage as a blanket Disallow would make an unrelated
    // failure look like a policy decision.
    const missing = await cache({}).forUrl("https://example.com/x");
    expect(missing.loaded).toBe(false);
    expect(missing.isAllowed("https://example.com/x", "brain-scrape")).toBe(true);

    const broken = await cache({
      "https://example.com/robots.txt": { status: 503, body: "" },
    }).forUrl("https://example.com/x");
    expect(broken.isAllowed("https://example.com/x", "brain-scrape")).toBe(true);

    const throwing = new RobotsCache({
      async fetcher() {
        throw new Error("network down");
      },
    });
    const rules = await throwing.forUrl("https://example.com/x");
    expect(rules.isAllowed("https://example.com/x", "brain-scrape")).toBe(true);
  });

  test("an unparseable URL is allowed rather than crashing the run", async () => {
    const rules = await cache({}).forUrl("not a url");
    expect(rules.isAllowed("not a url", "brain-scrape")).toBe(true);
  });
});

describe("RobotsDisallowedError", () => {
  test("names the URL, the agent, and the way out", () => {
    const err = new RobotsDisallowedError("https://example.com/private", "brain-scrape");
    expect(err.message).toContain("https://example.com/private");
    expect(err.message).toContain("brain-scrape");
    expect(err.message).toContain("allowDisallowed");
  });
});
