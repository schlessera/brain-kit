import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page, type HTTPRequest, type Target } from "puppeteer-core";
import { createBrowserSession, type BrowserSession } from "../src/browser/session.js";
import { ScrapeClient } from "../src/fetch/http.js";
import { RateLimiter } from "../src/politeness/rate-limit.js";
import { sleep as nativeSleep } from "../src/politeness/abort.js";
import { RobotsCache } from "../src/politeness/robots.js";
import { DEFAULT_USER_AGENT } from "../src/config/env.js";
import { runAdapters } from "../src/adapter/runner.js";

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") {
  throw new Error("Browser politeness tests require real Chrome");
}
if (!executablePath) console.warn("Skipping browser politeness: no Chrome installed");

describe.skipIf(!executablePath)("browser main-frame politeness (real Chrome, local origins)", () => {
  let chrome: Browser;
  let browserUrl: string;
  let first: ReturnType<typeof Bun.serve>;
  let second: ReturnType<typeof Bun.serve>;
  let rules: string;
  let hits: Array<{ path: string; origin: string; at: number; ua: string }>;
  const sessions: BrowserSession[] = [];
  let observeArrival: ((href: string) => void) | undefined;
  const body = () => document.body.textContent;
  const url = (path: string) => `${first.url.origin}${path}`;

  beforeAll(async () => {
    chrome = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    browserUrl = `http://127.0.0.1:${new URL(chrome.wsEndpoint()).port}`;
    function serve(req: Request): Response {
      const parsed = new URL(req.url);
      hits.push({ path: parsed.pathname, origin: parsed.origin, at: performance.now(), ua: req.headers.get("user-agent") ?? "" });
      observeArrival?.(req.url);
      if (parsed.pathname === "/robots.txt") return new Response(rules);
      if (parsed.pathname === "/same") return Response.redirect(`${first.url.origin}/denied`, 302);
      if (parsed.pathname === "/cross") return Response.redirect(`${second.url.origin}/denied`, 302);
      if (parsed.pathname === "/navigate") return new Response('<script>setTimeout(() => location.assign("/denied"), 50)</script>start', { headers: { "content-type": "text/html" } });
      if (parsed.pathname === "/assets") return new Response('<script src="/denied-script"></script><iframe src="/denied-frame"></iframe><img src="/denied-image"><div id="ready">ready</div>', { headers: { "content-type": "text/html" } });
      if (parsed.pathname === "/denied-script") return new Response('fetch("/denied-api")', { headers: { "content-type": "application/javascript" } });
      return new Response("fixture", { headers: { "content-type": "text/html", ...(parsed.pathname === "/denied" ? { "cache-control": "max-age=3600" } : {}) } });
    }
    first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve });
    second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve });
  });
  beforeEach(() => { hits = []; rules = "User-agent: *\nDisallow: /denied\n"; });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    // The observation connection receives TargetDestroyed after the session's
    // Page.close response; allow that CDP notification to arrive.
    for (let i = 0; i < 100 && (await chrome.pages()).length > 1; i++) await Bun.sleep(10);
    expect((await chrome.pages()).length).toBe(1);
  });
  afterAll(async () => { await chrome?.close(); first?.stop(true); second?.stop(true); });

  function session(extra = {}) {
    const s = createBrowserSession({ browserUrl, pageBudgetMs: 4000, ...extra });
    sessions.push(s);
    return s;
  }
  const requested = (path: string) => hits.filter((hit) => hit.path === path);

  /** Observe this original policy load, without replacing native operation promises. */
  function observePolicyLoad(robots: RobotsCache, watchedUrl: string) {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const policy = deferred();
    const handler = deferred();
    const destroyed = deferred();
    const escaped = deferred();
    const failed = deferred();
    let observerError: unknown;
    let hasObserverError = false;
    let disposed = false;
    const fail = (error: unknown) => { observerError = error; hasObserverError = true; failed.resolve(); };
    const restore: Array<() => void> = [];
    const forUrlDescriptor = Object.getOwnPropertyDescriptor(robots, "forUrl");
    const forUrl = robots.forUrl;
    Object.defineProperty(robots, "forUrl", {
      configurable: true, writable: true,
      value: function (this: RobotsCache, ...args: Parameters<RobotsCache["forUrl"]>) {
        const pending = Reflect.apply(forUrl, this, args) as ReturnType<RobotsCache["forUrl"]>;
        if (args[0] === watchedUrl) {
          const settled = () => { policy.resolve(); };
          void pending.then(settled, error => { settled(); fail(error); });
        }
        return pending;
      },
    });
    restore.push(() => {
      if (forUrlDescriptor) Object.defineProperty(robots, "forUrl", forUrlDescriptor);
      else Reflect.deleteProperty(robots, "forUrl");
    });
    observeArrival = href => { if (href === watchedUrl) escaped.resolve(); };
    restore.push(() => { observeArrival = undefined; });
    let watchedTarget: Target | undefined;
    const launch = () => {
      const connection = puppeteer.connect({ browserURL: browserUrl });
      void connection.then(browser => {
        if (disposed) return;
        const descriptor = Object.getOwnPropertyDescriptor(browser, "newPage");
        const newPage = browser.newPage;
        Object.defineProperty(browser, "newPage", {
          configurable: true, writable: true,
          value: function (this: Browser, ...args: Parameters<Browser["newPage"]>) {
            const pending = Reflect.apply(newPage, this, args) as Promise<Page>;
            void pending.then(page => {
              if (disposed) return;
              const target = page.target();
              let targetDestroyed = false;
              const onDestroyed = (closed: Target) => {
                if (closed !== target) return;
                targetDestroyed = true;
                if (watchedTarget === target) destroyed.resolve();
              };
              browser.on("targetdestroyed", onDestroyed);
              restore.push(() => { browser.off("targetdestroyed", onDestroyed); });
              const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
              const on = page.on;
              Object.defineProperty(page, "on", {
                configurable: true, writable: true,
                value: function (this: Page, ...args: unknown[]) {
                  if (args[0] !== "request") return Reflect.apply(on, this, args);
                  const listener = args[1] as (...events: unknown[]) => unknown;
                  const wrapped = function (this: unknown, ...events: unknown[]) {
                    const result = Reflect.apply(listener, this, events);
                    try {
                      const request = events[0] as HTTPRequest;
                      if (request.url() === watchedUrl && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                        watchedTarget = target;
                        if (targetDestroyed) destroyed.resolve();
                        const settled = () => { handler.resolve(); };
                        void Promise.resolve(result).then(settled, error => { settled(); fail(error); });
                      }
                    } catch (error) { fail(error); }
                    return result;
                  };
                  return Reflect.apply(on, this, [args[0], wrapped, ...args.slice(2)]);
                },
              });
              restore.push(() => {
                if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
                else Reflect.deleteProperty(page, "on");
              });
            }).catch(fail);
            return pending;
          },
        });
        restore.push(() => {
          if (descriptor) Object.defineProperty(browser, "newPage", descriptor);
          else Reflect.deleteProperty(browser, "newPage");
        });
      }).catch(fail);
      return connection;
    };
    return {
      launch,
      complete: (additional: Promise<unknown>[] = []) => Promise.race([
        Promise.all([policy.promise, handler.promise, destroyed.promise, ...additional]),
        escaped.promise,
        failed.promise,
      ]).then(() => { if (hasObserverError) throw observerError; }),
      restore: () => { disposed = true; for (const undo of restore.reverse()) undo(); },
    };
  }

  /** Keep pacing's real timer/cancellation; move only subsequent limiter eligibility. */
  function observeNativePacing(delayMs: number) {
    type Wait = {
      requestedMs: number;
      grantMs: number;
      clockReadMs: number;
      registeredMs?: number;
      handle?: ReturnType<typeof setTimeout>;
      active: boolean;
      clearCalls: number;
      callbackCalls: number;
      outcome: "pending" | "fulfilled" | "rejected";
    };
    const records: Wait[] = [];
    const descriptors = {
      setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!,
      clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!,
    };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let registering: Wait | undefined;
    let firstGrant: number | undefined;
    let lastRead: number | undefined;
    let offset = 0;
    let settled!: () => void;
    const sleepSettled = new Promise<void>(resolve => { settled = resolve; });
    Object.defineProperty(globalThis, "setTimeout", {
      ...descriptors.setTimeout,
      value: function (this: unknown, ...args: Parameters<typeof setTimeout>) {
        const [callback, milliseconds, ...callbackArgs] = args;
        const record = registering;
        if (!record || typeof callback !== "function") return Reflect.apply(originalSetTimeout, this, args);
        record.registeredMs = milliseconds;
        const wrapped = function (this: unknown, ...values: unknown[]) {
          record.callbackCalls++;
          record.active = false;
          return Reflect.apply(callback, this, values);
        };
        const handle = Reflect.apply(originalSetTimeout, this, [wrapped, milliseconds, ...callbackArgs]) as ReturnType<typeof setTimeout>;
        record.handle = handle;
        record.active = true;
        return handle;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      ...descriptors.clearTimeout,
      value: function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
        const record = records.find(wait => wait.handle !== undefined && wait.handle === args[0]);
        if (record) { record.clearCalls++; record.active = false; }
        return Reflect.apply(originalClearTimeout, this, args);
      },
    });
    return {
      records,
      sleepSettled,
      clock: {
        now: () => {
          const now = Date.now() + offset;
          // This instance's first acquire has no prior grant or queue predecessor.
          firstGrant ??= now;
          lastRead = now;
          return now;
        },
        sleep: (ms: number, signal?: AbortSignal) => {
          if (firstGrant === undefined || lastRead === undefined) throw new Error("Native pacing sleep preceded its clock read");
          const record: Wait = { requestedMs: ms, grantMs: firstGrant, clockReadMs: lastRead, active: false, clearCalls: 0, callbackCalls: 0, outcome: "pending" };
          records.push(record);
          registering = record;
          try {
            const pending = nativeSleep(ms, signal);
            void pending.then(
              () => { record.outcome = "fulfilled"; settled(); },
              () => { record.outcome = "rejected"; settled(); },
            );
            return pending;
          } finally { registering = undefined; }
        },
      },
      advanceEligibility() {
        if (firstGrant === undefined) throw new Error("No native pacing grant was observed");
        offset = Math.max(offset, firstGrant + delayMs - Date.now() + 1);
      },
      restore() {
        try {
          for (const record of records) {
            if (!record.active) continue;
            originalClearTimeout(record.handle);
            record.active = false;
          }
        } finally {
          Object.defineProperty(globalThis, "setTimeout", descriptors.setTimeout);
          Object.defineProperty(globalThis, "clearTimeout", descriptors.clearTimeout);
        }
      },
    };
  }

  test("standalone initial disallow never reaches the fixture origin", async () => {
    const error = await session().load({ url: url("/denied"), extract: body }).catch((err) => err);
    expect(requested("/denied")).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("robots.txt disallows");
    expect(requested("/robots.txt")).toHaveLength(1);
  });

  test.each(["/same", "/cross"])("redirect %s is refused before its target is sent", async (path) => {
    const error = await session().load({ url: url(path), extract: body }).catch((err) => err);
    expect(requested("/denied")).toHaveLength(0);
    expect(requested(path)).toHaveLength(1);
    expect(error.message).toContain("robots.txt disallows");
  });

  test("subsequent main-frame navigation during a load is refused", async () => {
    const error = await session().load({ url: url("/navigate"), waitForSelector: "#never", extract: body }).catch((err) => err);
    expect(requested("/denied")).toHaveLength(0);
    expect(requested("/navigate")).toHaveLength(1);
    expect(error.message).toContain("robots.txt disallows");
  });

  test("per-call permission covers its original origin and never persists", async () => {
    rules += "Crawl-delay: 1\n";
    const s = session();
    const request = { url: url("/same"), extract: body, allowDisallowed: true };
    expect(await s.load(request)).toBe("fixture");
    expect(requested("/denied")).toHaveLength(1);
    expect(requested("/denied")[0].at - requested("/same")[0].at).toBeGreaterThanOrEqual(850);
    hits = [];
    const error = await s.load({ url: url("/denied"), extract: body }).catch((err) => err);
    expect(requested("/denied")).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("robots.txt disallows");
  });

  test("per-call permission cannot authorize a disallowed cross-origin redirect", async () => {
    const request = { url: url("/cross"), extract: body, allowDisallowed: true };
    const error = await session().load(request).catch((err) => err);
    expect(requested("/denied")).toHaveLength(0);
    expect(requested("/cross")).toHaveLength(1);
    expect(error.message).toContain(second.url.origin);
  });

  test("robots matches the custom user agent actually sent by Chrome", async () => {
    rules = "User-agent: fixture-agent\nAllow: /\n\nUser-agent: *\nDisallow: /\n";
    expect(await session({ userAgent: "fixture-agent" }).load({ url: url("/allowed"), extract: body })).toBe("fixture");
    expect(requested("/allowed").map((hit) => hit.ua)).toEqual(["fixture-agent"]);
  });

  test("standalone Chrome uses the package default identity", async () => {
    expect(await session().load({ url: url("/allowed"), extract: body })).toBe("fixture");
    expect(requested("/allowed").map((hit) => hit.ua)).toEqual([DEFAULT_USER_AGENT]);
  });

  test("HTTP and concurrent browser requests share Crawl-delay and cached robots", async () => {
    rules = "User-agent: *\nAllow: /\nCrawl-delay: 1\n";
    const robots = new RobotsCache();
    const rateLimiter = new RateLimiter();
    const http = new ScrapeClient({ robots, rateLimiter });
    const s = session({ robots, rateLimiter });
    await http.getText(url("/http"));
    await Promise.all([s.load({ url: url("/one"), extract: body }), s.load({ url: url("/two"), extract: body }), http.getText(url("/three"))]);
    const main = hits.filter((hit) => ["/http", "/one", "/two", "/three"].includes(hit.path));
    expect(main).toHaveLength(4);
    for (let i = 1; i < main.length; i++) expect(main[i].at - main[i - 1].at).toBeGreaterThanOrEqual(850);
    expect(requested("/robots.txt")).toHaveLength(1);
  });

  test("generic runner shares its supplied HTTP client's policy state", async () => {
    rules = "User-agent: *\nAllow: /\nCrawl-delay: 1\n";
    const outcomes = await runAdapters({
      client: new ScrapeClient(), browser: { browserUrl },
      adapters: [{ id: "both", name: "Fixture", needsBrowser: true, needsProxy: false, async scrape(ctx) {
        await ctx.http.getText(url("/http"));
        return { items: [await ctx.browser!.load({ url: url("/browser"), extract: body })], errors: [], status: "ok" as const };
      } }],
    });
    expect(outcomes[0].errors).toEqual([]);
    expect(outcomes[0].items).toEqual(["fixture"]);
    expect(requested("/browser")[0].at - requested("/http")[0].at).toBeGreaterThanOrEqual(850);
    expect(requested("/robots.txt")).toHaveLength(1);
  });

  test("ordinary scripts, images, frames and page API calls are outside coverage", async () => {
    expect(await session().load({ url: url("/assets"), waitForSelector: "#ready", settleMs: 150, extract: body })).toContain("ready");
    for (const path of ["/denied-script", "/denied-image", "/denied-frame", "/denied-api"]) expect(requested(path)).toHaveLength(1);
  });

  test("policy waits time out, close pages and release capacity without a late request", async () => {
    const robots = new RobotsCache({ fetcher: async () => { await Bun.sleep(800); return { status: 200, body: "User-agent: *\nAllow: /" }; } });
    const observation = observePolicyLoad(robots, url("/late"));
    try {
      const s = session({ robots, pageBudgetMs: 250, concurrency: 1, launch: observation.launch });
      const error = await s.load({ url: url("/late"), extract: body }).catch((err) => err);
      expect(requested("/late")).toHaveLength(0);
      expect(error.message).toContain("budget");
      await observation.complete();
      expect(requested("/late")).toHaveLength(0);
      expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
    } finally { observation.restore(); }
  });

  test("a timed-out pacing wait sends no late request and releases page capacity", async () => {
    const pacing = observeNativePacing(1200);
    const robots = new RobotsCache();
    const observation = observePolicyLoad(robots, url("/late-paced"));
    try {
      const s = session({ robots, rateLimiter: new RateLimiter({ defaultDelayMs: 1200, clock: pacing.clock }), pageBudgetMs: 300, concurrency: 1, launch: observation.launch });
      expect(await s.load({ url: url("/first"), extract: body })).toBe("fixture");
      const error = await s.load({ url: url("/late-paced"), extract: body }).catch((err) => err);
      expect(requested("/late-paced")).toHaveLength(0);
      expect(error.message).toContain("budget");
      expect(pacing.records).toHaveLength(1);
      await observation.complete([pacing.sleepSettled]);
      expect(requested("/late-paced")).toHaveLength(0);
      const wait = pacing.records[0]!;
      expect(wait.registeredMs).toBe(wait.requestedMs);
      expect(wait.requestedMs + wait.clockReadMs - wait.grantMs).toBe(1200);
      expect(wait.clearCalls).toBe(1);
      expect(wait.callbackCalls).toBe(0);
      expect(wait.outcome).toBe("rejected");
      pacing.advanceEligibility();
      expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
      expect(pacing.records).toHaveLength(1);
    } finally {
      try { observation.restore(); } finally { pacing.restore(); }
    }
  });

  test("invalid URLs and selector timeouts release capacity for the next load", async () => {
    const s = session({ pageBudgetMs: 300, concurrency: 1 });
    await expect(s.load({ url: "invalid URL", extract: body })).rejects.toThrow();
    await expect(s.load({ url: url("/allowed"), waitForSelector: "#never", extract: body })).rejects.toThrow();
    expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
  });
});
