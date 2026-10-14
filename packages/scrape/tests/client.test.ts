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

/**
 * HTTP retry time is separate from the injected rate-limit clock. Capture the
 * actual production timeout callbacks, leaving Date, fetch promises and native
 * event-loop turns alone. This file only scripts responses; it has no socket or
 * media clock that a logical advance could accidentally outrun.
 */
class RetryClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; delay: number; callback: () => void }>();
  readonly registered: number[] = [];
  readonly cancelled: number[] = [];
  readonly delivered: number[] = [];
  readonly requests: { settled: boolean }[] = [];

  setTimeout = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = this.nextId++;
    this.registered.push(delay);
    this.timers.set(id, { at: this.now + delay, delay, callback: () => callback(...args) });
    return id;
  };
  clearTimeout = (id: number) => {
    const timer = this.timers.get(id);
    if (timer) this.cancelled.push(timer.delay);
    this.timers.delete(id);
  };
  get pending(): number[] {
    return [...this.timers.values()].map(timer => timer.delay);
  }
  track<T>(promise: Promise<T>): Promise<T> {
    const state = { settled: false };
    this.requests.push(state);
    // Observe both outcomes immediately, including during failure cleanup.
    void promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return promise;
  }
  async turn(): Promise<void> {
    // Give these scripted promise chains a native event-loop opportunity.
    // Pending-registration and tracked-settlement assertions below establish
    // completion; a turn alone is not an arbitrary asynchronous-work barrier.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      this.delivered.push(next[1].delay);
      next[1].callback();
      await this.turn();
    }
    this.now = end;
    await this.turn();
  }
  async dispose(): Promise<void> {
    // A failed assertion may leave a retry parked. Complete the finite scripted
    // request while our globals still belong to it, then discard stray watchdogs.
    try {
      await this.turn();
      for (let i = 0; this.requests.some(request => !request.settled) && i < 32; i++) {
        const next = Math.min(...[...this.timers.values()].map(timer => timer.at));
        if (!Number.isFinite(next)) break;
        await this.advance(Math.max(0, next - this.now));
      }
      expect(this.requests.every(request => request.settled), "REQUEST_CLEANUP").toBe(true);
    } finally {
      this.timers.clear();
    }
  }
}

async function withRetryClock<T>(run: (clock: RetryClock) => Promise<T>, jitter = 0.5): Promise<T> {
  const timers = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!,
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!,
  };
  const random = Object.getOwnPropertyDescriptor(Math, "random")!;
  const clock = new RetryClock();
  Object.defineProperties(globalThis, {
    setTimeout: { configurable: true, writable: true, value: clock.setTimeout },
    clearTimeout: { configurable: true, writable: true, value: clock.clearTimeout },
  });
  Object.defineProperty(Math, "random", { configurable: true, writable: true, value: () => jitter });
  try {
    return await run(clock);
  } finally {
    try { await clock.dispose(); }
    finally {
      Object.defineProperties(globalThis, timers);
      Object.defineProperty(Math, "random", random);
    }
  }
}

async function retryAt(clock: RetryClock, calls: Call[], delay: number, attempts: number): Promise<void> {
  await clock.turn();
  expect(clock.cancelled, "WATCHDOG_CANCELLED_BEFORE_RETRY").toEqual(Array(attempts).fill(30_000));
  expect(clock.pending, "RETRY_REGISTRATION").toEqual([delay]);
  expect(calls.length).toBe(attempts);
  await clock.advance(delay - 1);
  expect(calls.length, "NO_EARLY_RETRY").toBe(attempts);
  await clock.advance(1);
  expect(calls.length, "RETRY_AT_DEADLINE").toBe(attempts + 1);
}

async function retriesFinished(clock: RetryClock, calls: Call[], attempts: number): Promise<void> {
  await clock.turn();
  expect(clock.requests.every(request => request.settled), "REQUEST_SETTLED").toBe(true);
  expect(clock.cancelled, "FINAL_WATCHDOG_CANCELLED").toEqual(Array(attempts).fill(30_000));
  expect(clock.pending, "NO_RETRY_AFTER_COMPLETION").toEqual([]);
  // Cross the watchdog horizon and all expected retry deadlines: cancellation
  // is observed through the real callback opportunity, not immediate absence.
  await clock.advance(60_000);
  expect(calls.length, "NO_EXTRA_REQUEST").toBe(attempts);
  expect(clock.delivered.every(delay => delay < 30_000), "NO_STALE_WATCHDOG").toBe(true);
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

  test("a Crawl-delay longer than any crawler can wait refuses the request", async () => {
    // Ignoring it would treat the strictest spacing a site can ask for as no
    // spacing at all.
    for (const value of ["Infinity", "1e306", "3000000"]) {
      const calls = stubFetch([new Response("ok")]);
      const client = new ScrapeClient({ robots: robotsFor(`User-agent: *\nCrawl-delay: ${value}\n`) });

      await expect(client.get("https://example.com/a")).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(`${value}: ${calls.length}`).toBe(`${value}: 0`);
    }
  });

  test("overriding an unfollowable Crawl-delay keeps the caller's own delay", async () => {
    for (const value of ["Infinity", "3000000"]) {
      stubFetch([new Response("ok"), new Response("ok")]);
      const clock = fakeClock();
      const client = new ScrapeClient({
        robots: robotsFor(`User-agent: *\nCrawl-delay: ${value}\n`),
        rateLimiter: new RateLimiter({ defaultDelayMs: 100, clock }),
      });

      await client.get("https://example.com/a", { allowDisallowed: true, delayMs: 5000 });
      await client.get("https://example.com/b", { allowDisallowed: true, delayMs: 5000 });

      expect(`${value}: ${clock.waits.join(",")}`).toBe(`${value}: 5000`);
    }
  });

  test("a non-finite per-call delay does not erase the Crawl-delay floor", async () => {
    // The two are combined before the limiter sees them, so an unusable
    // caller value has to be dropped on its own, not along with the site's.
    for (const delayMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      stubFetch([new Response("ok"), new Response("ok")]);
      const clock = fakeClock();
      const client = new ScrapeClient({
        robots: robotsFor("User-agent: *\nCrawl-delay: 7\n"),
        rateLimiter: new RateLimiter({ defaultDelayMs: 100, clock }),
      });

      await client.get("https://example.com/a", { delayMs });
      await client.get("https://example.com/b", { delayMs });

      expect(`${delayMs}: ${clock.waits.join(",")}`).toBe(`${delayMs}: 7000`);
    }
  });
});

describe("retries", () => {
  test("retries a 429 and honours Retry-After", async () => {
    const calls = stubFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const client = new ScrapeClient({ respectRobots: false });

    await withRetryClock(async clock => {
      const request = clock.track(client.get("https://example.com/x", { retryDelayMs: 1 }));
      await retryAt(clock, calls, 1000, 1);
      const res = await request;

      expect(res.status).toBe(200);
      expect(calls.length).toBe(2);
      expect(clock.registered).toEqual([30_000, 1000, 30_000]);
      await retriesFinished(clock, calls, 2);
    });
  });

  test("does not retry a 404 — the answer will not change", async () => {
    const calls = stubFetch([() => new Response("gone", { status: 404 })]);
    const client = new ScrapeClient({ respectRobots: false });

    const res = await client.get("https://example.com/x", { retryDelayMs: 1 });

    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  test("gives up after the configured retries, naming the status", async () => {
    const calls = stubFetch([() => new Response("boom", { status: 503 })]);
    const client = new ScrapeClient({ respectRobots: false });

    await withRetryClock(async clock => {
      const request = clock.track(client.get("https://example.com/x", { retries: 2, retryDelayMs: 1 }));
      await retryAt(clock, calls, 251, 1);
      await retryAt(clock, calls, 252, 2);
      expect(clock.pending, "NO_RETRY_AFTER_EXHAUSTION").toEqual([]);
      expect(clock.requests.every(request => request.settled), "EXHAUSTED_REQUEST_SETTLED").toBe(true);
      await expect(request).rejects.toThrow(/HTTP 503/);
      expect(clock.registered).toEqual([30_000, 251, 30_000, 252, 30_000]);
      await retriesFinished(clock, calls, 3);
    });
  });

  for (const [jitter, delay] of [[0, 1000], [0.5, 1250], [0.998, 1499]] as const) {
    test(`default backoff uses a 1000 ms base plus jitter ${jitter} (deadline ${delay})`, async () => {
      const calls = stubFetch([
        () => new Response("unavailable", { status: 503 }),
        () => new Response("ok"),
      ]);
      const client = new ScrapeClient({ respectRobots: false });
      await withRetryClock(async clock => {
        const request = clock.track(client.get("https://example.com/x"));
        await retryAt(clock, calls, delay, 1);
        expect((await request).status).toBe(200);
        expect(clock.delivered).toEqual([delay]);
        expect(clock.delivered[0]).toBeGreaterThanOrEqual(1000);
        expect(clock.delivered[0]).toBeLessThan(1500);
        await retriesFinished(clock, calls, 2);
      }, jitter);
    });
  }

  test("the request watchdog stays live until fetch settles, then is cancelled", async () => {
    let release!: (response: Response) => void;
    let signal!: AbortSignal;
    const response = new Promise<Response>(resolve => { release = resolve; });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return response;
    }) as typeof fetch;
    const client = new ScrapeClient({ respectRobots: false });
    await withRetryClock(async clock => {
      const request = clock.track(client.get("https://example.com/x", { retries: 0 }));
      try {
        await clock.turn();
        expect(clock.registered, "DEFAULT_WATCHDOG").toEqual([30_000]);
        expect(clock.pending, "WATCHDOG_LIVE_DURING_FETCH").toEqual([30_000]);
        await clock.advance(29_999);
        expect(signal.aborted).toBe(false);
        expect(clock.requests[0]!.settled).toBe(false);
        release(new Response("ok"));
        expect((await request).status).toBe(200);
        expect(clock.cancelled, "WATCHDOG_CANCELLED_AFTER_FETCH").toEqual([30_000]);
        await clock.advance(1);
        expect(signal.aborted, "SETTLED_FETCH_NOT_ABORTED").toBe(false);
        expect(clock.delivered).toEqual([]);
      } finally {
        release(new Response("cleanup"));
      }
    });
  });

  test("a failed assertion drains the pending retry and restores global descriptors", async () => {
    const descriptors = {
      setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout"),
      clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout"),
      random: Object.getOwnPropertyDescriptor(Math, "random"),
    };
    const calls = stubFetch([
      () => new Response("unavailable", { status: 503 }),
      () => new Response("ok"),
    ]);
    const client = new ScrapeClient({ respectRobots: false });
    let owned!: RetryClock;
    let request!: Promise<Response>;
    await expect(withRetryClock(async clock => {
      owned = clock;
      request = clock.track(client.get("https://example.com/x", { retryDelayMs: 1 }));
      await clock.turn();
      expect(clock.pending).toEqual([251]);
      expect("fixture", "INTENTIONAL_ASSERTION_FAILURE").toBe("failure");
    })).rejects.toThrow("INTENTIONAL_ASSERTION_FAILURE");
    expect((await request).status).toBe(200);
    expect(calls.length).toBe(2);
    expect(owned.pending).toEqual([]);
    expect(owned.requests.every(request => request.settled)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(globalThis, "setTimeout")).toEqual(descriptors.setTimeout);
    expect(Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")).toEqual(descriptors.clearTimeout);
    expect(Object.getOwnPropertyDescriptor(Math, "random")).toEqual(descriptors.random);
  });

  test("getJson throws on a non-2xx rather than parsing an error page", async () => {
    stubFetch([() => new Response("<html>nope</html>", { status: 403 })]);
    const client = new ScrapeClient({ respectRobots: false });

    await expect(client.getJson("https://example.com/x")).rejects.toThrow(/HTTP 403/);
  });
});

/**
 * Replace global fetch with one that answers by URL, and that honours
 * `redirect` the way fetch does: unless it is "manual", the double follows a
 * redirect itself, so a client that stops following by hand is caught
 * requesting the target without checking it.
 */
function routeFetch(route: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    let url = String(input);
    for (let hops = 0; ; hops++) {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const response = route(url);
      const location = response.headers.get("location");
      if (init?.redirect === "manual" || !location || hops === 20) return response;
      url = new URL(location, url).href;
    }
  }) as typeof fetch;
  return calls;
}

function redirect(location: string, status = 301): Response {
  return new Response("moved", { status, headers: { location } });
}

/** A robots cache that answers per origin and records which robots.txt it fetched. */
function robotsByOrigin(bodies: Record<string, string>): { robots: RobotsCache; fetched: string[] } {
  const fetched: string[] = [];
  const robots = new RobotsCache({
    async fetcher(robotsUrl) {
      fetched.push(robotsUrl);
      const body = bodies[new URL(robotsUrl).origin];
      return body === undefined ? { status: 404, body: "" } : { status: 200, body };
    },
  });
  return { robots, fetched };
}

/** A limiter that records the host of every acquire. */
class RecordingLimiter extends RateLimiter {
  readonly hosts: string[] = [];
  override async acquire(host: string, delayMs?: number): Promise<void> {
    this.hosts.push(host);
    return super.acquire(host, delayMs);
  }
}

describe("retries are paced", () => {
  test("a retry waits out Crawl-delay like the first attempt", async () => {
    const calls = stubFetch([
      () => new Response("unavailable", { status: 503 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const clock = fakeClock();
    const client = new ScrapeClient({
      robots: robotsFor("User-agent: *\nCrawl-delay: 7\n"),
      rateLimiter: new RateLimiter({ clock }),
    });

    await withRetryClock(async retryClock => {
      const request = retryClock.track(client.get("https://example.com/a", { retryDelayMs: 1 }));
      await retryClock.turn();
      expect(clock.waits).toEqual([]);
      await retryAt(retryClock, calls, 251, 1);
      const res = await request;

      expect(res.status).toBe(200);
      expect(calls.length).toBe(2);
      expect(clock.waits).toEqual([7000]);
      await retriesFinished(retryClock, calls, 2);
    });
  });
});

describe("redirects", () => {
  test("a redirect to a disallowed path throws before the target is requested", async () => {
    const calls = routeFetch((url) =>
      url.endsWith("/jobs") ? redirect("https://example.com/private") : new Response("secret")
    );
    const client = new ScrapeClient({ robots: robotsFor("User-agent: *\nDisallow: /private\n") });

    const err = await client.get("https://example.com/jobs").catch((e) => e);

    expect(err).toBeInstanceOf(RobotsDisallowedError);
    expect((err as RobotsDisallowedError).url).toBe("https://example.com/private");
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/jobs"]);
  });

  test("a redirect to another origin resolves its robots.txt and paces its host", async () => {
    routeFetch((url) =>
      url.startsWith("https://example.com/") ? redirect("https://other.example/b", 302) : new Response("ok")
    );
    const { robots, fetched } = robotsByOrigin({});
    const limiter = new RecordingLimiter();
    const client = new ScrapeClient({ robots, rateLimiter: limiter });

    const page = await client.getPage("https://example.com/a");

    expect(page).toEqual({ body: "ok", url: "https://other.example/b" });
    expect(fetched).toEqual(["https://example.com/robots.txt", "https://other.example/robots.txt"]);
    expect(limiter.hosts).toEqual(["example.com", "other.example"]);
  });

  test("allowDisallowed lets a same-origin disallowed hop through", async () => {
    const calls = routeFetch((url) =>
      url.endsWith("/jobs") ? redirect("/private/list") : new Response("listed")
    );
    const client = new ScrapeClient({ robots: robotsFor("User-agent: *\nDisallow: /\n") });

    const page = await client.getPage("https://example.com/jobs", { allowDisallowed: true });

    expect(page).toEqual({ body: "listed", url: "https://example.com/private/list" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/jobs",
      "https://example.com/private/list",
    ]);
  });

  test("allowDisallowed does not cover a hop to another origin", async () => {
    const calls = routeFetch((url) =>
      url.startsWith("https://example.com/") ? redirect("https://other.example/private") : new Response("x")
    );
    const { robots } = robotsByOrigin({
      "https://example.com": "User-agent: *\nDisallow: /\n",
      "https://other.example": "User-agent: *\nDisallow: /private\n",
    });
    const client = new ScrapeClient({ robots });

    const err = await client
      .get("https://example.com/jobs", { allowDisallowed: true })
      .catch((e) => e);

    expect(err).toBeInstanceOf(RobotsDisallowedError);
    expect((err as RobotsDisallowedError).url).toBe("https://other.example/private");
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/jobs"]);
  });

  /** `/0` redirects to `/1` and so on; `/<last>` answers with a body. */
  function chain(last: number): Call[] {
    return routeFetch((url) => {
      const n = Number(new URL(url).pathname.slice(1));
      return n < last ? redirect(`/${n + 1}`, 307) : new Response(`end of ${n}`);
    });
  }

  test("a 3-hop chain returns the final body and reports the final URL", async () => {
    const calls = chain(3);
    const client = new ScrapeClient({ respectRobots: false });

    const page = await client.getPage("https://example.com/0");

    expect(page).toEqual({ body: "end of 3", url: "https://example.com/3" });
    expect(calls.length).toBe(4);
  });

  test("20 redirects are followed and the 21st throws, naming the start and the limit", async () => {
    chain(20);
    const client = new ScrapeClient({ respectRobots: false });
    expect((await client.getPage("https://example.com/0")).url).toBe("https://example.com/20");

    const calls = chain(21);
    await expect(client.get("https://example.com/0")).rejects.toThrow(
      "https://example.com/0 redirected more than 20 times"
    );
    expect(calls.length).toBe(21);
  });

  const CALLER_HEADERS = {
    Authorization: "Bearer t",
    Cookie: "s=1",
    "Proxy-Authorization": "Basic p",
    "X-Api-Key": "k",
    Accept: "text/html",
  };

  test("only identity and content negotiation follow a redirect to another origin", async () => {
    const calls = routeFetch((url) =>
      url.startsWith("https://example.com/") ? redirect("https://other.example/b") : new Response("ok")
    );
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/a", { headers: CALLER_HEADERS });

    expect(calls[0].headers).toEqual({ "User-Agent": DEFAULT_USER_AGENT, ...CALLER_HEADERS });
    expect(calls[1].headers).toEqual({ "User-Agent": DEFAULT_USER_AGENT, Accept: "text/html" });
  });

  test("a same-origin hop keeps the caller's headers", async () => {
    const calls = routeFetch((url) => (url.endsWith("/a") ? redirect("/b") : new Response("ok")));
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/a", { headers: CALLER_HEADERS });

    expect(calls.map((c) => c.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(calls[1].headers).toEqual(calls[0].headers);
    expect(calls[1].headers["X-Api-Key"]).toBe("k");
  });

  test("a downgrade from https to http on the same host sends no credentials", async () => {
    const calls = routeFetch((url) =>
      url.startsWith("https:") ? redirect("http://example.com/b") : new Response("ok")
    );
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/a", { headers: CALLER_HEADERS });

    expect(calls.map((c) => c.url)).toEqual(["https://example.com/a", "http://example.com/b"]);
    expect(calls[1].headers).toEqual({ "User-Agent": DEFAULT_USER_AGENT, Accept: "text/html" });
  });

  test("a redirect off http(s) is refused rather than followed", async () => {
    const calls = routeFetch(() => redirect("file:///etc/passwd"));
    const client = new ScrapeClient({ respectRobots: false });

    await expect(client.get("https://example.com/a")).rejects.toThrow(/unsupported URL file:/);
    expect(calls.length).toBe(1);
  });
});

describe("the proxy path", () => {
  const realSpawn = Bun.spawn;
  afterEach(() => {
    (Bun as any).spawn = realSpawn;
  });

  interface CurlAnswer {
    status: number;
    body: string;
    location?: string;
  }

  /**
   * Replace Bun.spawn with a fake curl that answers by URL and honours the
   * flags this client depends on: it follows redirects itself under `-L`,
   * expands a `[n-m]` range unless `--globoff` is set, and prints only what
   * the `-w` format asks for. Returns the argument lists and every URL the
   * fake curl requested.
   */
  function stubCurl(route: (url: string) => CurlAnswer): { spawned: string[][]; requested: string[] } {
    const spawned: string[][] = [];
    const requested: string[] = [];
    (Bun as any).spawn = (args: string[]) => {
      spawned.push(args);
      const target = args[args.length - 1];
      const range = /\[(\d+)-(\d+)\]/.exec(target);
      const urls =
        range && !args.includes("--globoff") && !args.includes("-g")
          ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) =>
              target.replace(range[0], String(Number(range[1]) + i))
            )
          : [target];

      let out = "";
      for (let url of urls) {
        let answer: CurlAnswer;
        for (let hops = 0; ; hops++) {
          requested.push(url);
          answer = route(url);
          if (!args.includes("-L") || !answer.location || hops === 20) break;
          url = new URL(answer.location, url).href;
        }
        const writeOut = args[args.indexOf("-w") + 1] ?? "";
        out += answer.body + writeOut
          .replaceAll("%{http_code}", String(answer.status))
          .replaceAll("%{redirect_url}", args.includes("-L") ? "" : (answer.location ?? ""));
      }
      return {
        stdout: new Response(out).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    };
    return { spawned, requested };
  }

  const PROXY = { proxy: "http://proxy.test:8080" };

  test("curl does not follow redirects; the client does, hop by hop", async () => {
    const { spawned, requested } = stubCurl((url) =>
      url.endsWith("/a")
        ? { status: 301, body: "moved", location: "https://example.com/b" }
        : { status: 200, body: "final" }
    );
    const client = new ScrapeClient({ respectRobots: false });

    const page = await client.getPage("https://example.com/a", PROXY);

    expect(page).toEqual({ body: "final", url: "https://example.com/b" });
    expect(requested).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(spawned.length).toBe(2);
    for (const args of spawned) expect(args).not.toContain("-L");
  });

  test("a proxied redirect is held to robots.txt too", async () => {
    const { requested } = stubCurl(() => ({
      status: 302,
      body: "moved",
      location: "https://example.com/private",
    }));
    const client = new ScrapeClient({ robots: robotsFor("User-agent: *\nDisallow: /private\n") });

    await expect(client.get("https://example.com/jobs", PROXY)).rejects.toBeInstanceOf(
      RobotsDisallowedError
    );
    expect(requested).toEqual(["https://example.com/jobs"]);
  });

  test("a bracketed redirect target is one request, not a curl range", async () => {
    // `/[1-3]` is one path to robots.txt and the limiter; to a globbing curl
    // it is three requests, one of them to the disallowed `/1`.
    const { requested } = stubCurl((url) =>
      url.endsWith("/jobs")
        ? { status: 302, body: "moved", location: "https://example.com/[1-3]" }
        : { status: 200, body: "page" }
    );
    const client = new ScrapeClient({ robots: robotsFor("User-agent: *\nDisallow: /1\n") });

    const page = await client.getPage("https://example.com/jobs", PROXY);

    expect(requested).toEqual(["https://example.com/jobs", "https://example.com/[1-3]"]);
    expect(page.body).toBe("page");
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
