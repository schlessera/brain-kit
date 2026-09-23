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

  /**
   * Run concurrent acquisitions against a clock that only moves when the test
   * moves it, and report the instant each one was granted, in grant order.
   * `first` is acquired (and awaited) at t=0 before the concurrent callers
   * start, so they all arrive while its slot is the most recent one.
   */
  async function grantTimes(
    limiter: (clock: RateLimiterClock) => RateLimiter,
    first: number | undefined,
    concurrent: Array<number | undefined>
  ): Promise<number[]> {
    let now = 0;
    const pending: Array<{ at: number; wake: () => void }> = [];
    const clock: RateLimiterClock = {
      now: () => now,
      sleep: (ms) => new Promise<void>((resolve) => pending.push({ at: now + ms, wake: resolve })),
    };
    const subject = limiter(clock);
    const acquiredAt: number[] = [];

    await subject.acquire("a.example", first);
    acquiredAt.push(now);

    const callers = concurrent.map((delayMs) =>
      subject.acquire("a.example", delayMs).then(() => acquiredAt.push(now))
    );

    // Let every caller that can be granted without a wait go, then run the
    // fake clock forward to each scheduled wake-up in turn. `setImmediate`
    // runs after the whole microtask queue, so no promise hop is left pending.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    await settle();
    for (let step = 0; step < 20 && pending.length > 0; step++) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending.shift()!;
      now = Math.max(now, next.at);
      next.wake();
      await settle();
    }
    await Promise.all(callers);
    return acquiredAt;
  }

  test("CONCURRENT callers to one host are spaced, not woken together", async () => {
    // brain-kit#33 measured the burst this pins against: `acquire` used to read
    // `lastStart`, await, and only then claim the slot, so two callers that
    // arrived before either had claimed it computed the same wait and fired
    // together. Every other test in this describe acquires SEQUENTIALLY, which
    // is the one case that bug cannot show up in.
    const acquiredAt = await grantTimes((clock) => new RateLimiter({ clock }), 1000, [1000, 1000]);
    expect(acquiredAt).toEqual([0, 1000, 2000]);
  });

  test("three concurrent callers are each spaced by the default delay", async () => {
    const acquiredAt = await grantTimes(
      (clock) => new RateLimiter({ defaultDelayMs: 1000, clock }),
      undefined,
      [undefined, undefined, undefined]
    );
    expect(acquiredAt).toEqual([0, 1000, 2000, 3000]);
  });

  test("a Crawl-delay override on one concurrent call pushes the caller after it back", async () => {
    // The override spaces its own call by the larger value (3000, not the
    // default 1000), and the caller queued behind it is spaced from that later
    // slot rather than from the one before it.
    const acquiredAt = await grantTimes(
      (clock) => new RateLimiter({ defaultDelayMs: 1000, clock }),
      undefined,
      [undefined, 3000, undefined]
    );
    expect(acquiredAt).toEqual([0, 1000, 4000, 5000]);
  });

  test("a zero-delay call goes straight through without breaking the queue", async () => {
    // With no default, a call without a Crawl-delay is granted at once, but the
    // delayed callers either side of it are still spaced from each other.
    const acquiredAt = await grantTimes((clock) => new RateLimiter({ clock }), undefined, [1000, 0, 1000]);
    expect(acquiredAt).toEqual([0, 0, 1000, 2000]);
  });

  test("after an idle gap the next slot is claimed at now, not in the past", async () => {
    // The host was last hit long ago, so the first caller goes straight
    // through — but its slot must be recorded as NOW, or the caller behind it
    // would be spaced from a stale instant and fire at once.
    const clock = fakeClock();
    const limiter = new RateLimiter({ defaultDelayMs: 1000, clock });

    await limiter.acquire("a.example");
    clock.time += 5000;
    await limiter.acquire("a.example");
    await limiter.acquire("a.example");

    expect(clock.waits).toEqual([1000]);
  });

  test("a timer that fires late does not let the next caller in early", async () => {
    // The spacing is measured from when the previous request was actually
    // granted. A limiter that recorded the SCHEDULED wake-up instead would see
    // the overshoot as time already served and let the third call straight
    // through.
    const clock = fakeClock();
    clock.sleep = async (ms: number) => {
      clock.waits.push(ms);
      clock.time += ms + 1500; // the event loop was busy
    };
    const limiter = new RateLimiter({ defaultDelayMs: 1000, clock });

    await limiter.acquire("a.example");
    await limiter.acquire("a.example");
    await limiter.acquire("a.example");

    expect(clock.waits).toEqual([1000, 1000]);
  });

  test("a request made while a caller sleeps restarts that caller's wait", async () => {
    // A zero-delay call hits the host at t=500 while a caller with a 1000 ms
    // delay is asleep until t=1000. That caller's delay is measured from the
    // most recent request, so it goes back to sleep until t=1500.
    let now = 0;
    const pending: Array<{ at: number; wake: () => void }> = [];
    const clock: RateLimiterClock = {
      now: () => now,
      sleep: (ms) => new Promise<void>((resolve) => pending.push({ at: now + ms, wake: resolve })),
    };
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const limiter = new RateLimiter({ clock });

    await limiter.acquire("a.example", 1000);
    let grantedAt: number | undefined;
    const delayed = limiter.acquire("a.example", 1000).then(() => (grantedAt = now));
    await settle();

    now = 500;
    await limiter.acquire("a.example");

    const first = pending.shift()!;
    expect(first.at).toBe(1000);
    now = first.at;
    first.wake();
    await settle();
    expect(grantedAt).toBeUndefined();

    const second = pending.shift()!;
    expect(second.at).toBe(1500);
    now = second.at;
    second.wake();
    await delayed;
    expect(grantedAt).toBe(1500);
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
