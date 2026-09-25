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

/** Replace global fetch with one that answers by URL. */
function routeFetch(route: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return route(String(input));
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

    const res = await client.get("https://example.com/a", { retryDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(clock.waits).toEqual([7000]);
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

  test("credentials do not follow a redirect to another origin", async () => {
    const calls = routeFetch((url) =>
      url.startsWith("https://example.com/") ? redirect("https://other.example/b") : new Response("ok")
    );
    const client = new ScrapeClient({ respectRobots: false });

    await client.get("https://example.com/a", {
      headers: { Authorization: "Bearer t", Cookie: "s=1", "X-Trace": "1" },
    });

    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer t", Cookie: "s=1" });
    expect(calls[1].headers["X-Trace"]).toBe("1");
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[1].headers.Cookie).toBeUndefined();
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

  /** Replace Bun.spawn with a fake curl that prints each scripted output in turn. */
  function stubCurl(outputs: string[]): string[][] {
    const spawned: string[][] = [];
    (Bun as any).spawn = (args: string[]) => {
      spawned.push(args);
      const out = outputs[Math.min(spawned.length - 1, outputs.length - 1)];
      return {
        stdout: new Response(out).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    };
    return spawned;
  }

  test("curl does not follow redirects; the client does, hop by hop", async () => {
    const spawned = stubCurl(["moved\n301\nhttps://example.com/b", "final\n200\n"]);
    const client = new ScrapeClient({ respectRobots: false });

    const page = await client.getPage("https://example.com/a", { proxy: "http://proxy.test:8080" });

    expect(spawned.length).toBe(2);
    for (const args of spawned) expect(args).not.toContain("-L");
    expect(spawned.map((args) => args[args.length - 1])).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(page).toEqual({ body: "final", url: "https://example.com/b" });
  });

  test("a proxied redirect is held to robots.txt too", async () => {
    const spawned = stubCurl(["moved\n302\nhttps://example.com/private"]);
    const client = new ScrapeClient({ robots: robotsFor("User-agent: *\nDisallow: /private\n") });

    await expect(
      client.get("https://example.com/jobs", { proxy: "http://proxy.test:8080" })
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(spawned.length).toBe(1);
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
