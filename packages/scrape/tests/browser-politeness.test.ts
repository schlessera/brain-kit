import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { createBrowserSession, type BrowserSession } from "../src/browser/session.js";
import { ScrapeClient } from "../src/fetch/http.js";
import { RateLimiter } from "../src/politeness/rate-limit.js";
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
  const body = () => document.body.textContent;
  const url = (path: string) => `${first.url.origin}${path}`;

  beforeAll(async () => {
    chrome = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    browserUrl = `http://127.0.0.1:${new URL(chrome.wsEndpoint()).port}`;
    function serve(req: Request): Response {
      const parsed = new URL(req.url);
      hits.push({ path: parsed.pathname, origin: parsed.origin, at: performance.now(), ua: req.headers.get("user-agent") ?? "" });
      if (parsed.pathname === "/robots.txt") return new Response(rules);
      if (parsed.pathname === "/same") return Response.redirect(`${first.url.origin}/denied`, 302);
      if (parsed.pathname === "/cross") return Response.redirect(`${second.url.origin}/denied`, 302);
      if (parsed.pathname === "/navigate") return new Response('<script>setTimeout(() => location.assign("/denied"), 50)</script>start', { headers: { "content-type": "text/html" } });
      if (parsed.pathname === "/assets") return new Response('<script src="/denied-script"></script><iframe src="/denied-frame"></iframe><img src="/denied-image"><div id="ready">ready</div>', { headers: { "content-type": "text/html" } });
      if (parsed.pathname === "/denied-script") return new Response('fetch("/denied-api")', { headers: { "content-type": "application/javascript" } });
      return new Response("fixture", { headers: { "content-type": "text/html" } });
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
        return { items: [await ctx.browser!.load({ url: url("/browser"), extract: body })], errors: [] };
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
    const s = session({ robots, pageBudgetMs: 250, concurrency: 1 });
    const error = await s.load({ url: url("/late"), extract: body }).catch((err) => err);
    expect(requested("/late")).toHaveLength(0);
    expect(error.message).toContain("budget");
    await Bun.sleep(820);
    expect(requested("/late")).toHaveLength(0);
    expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
  });

  test("a timed-out pacing wait sends no late request and releases page capacity", async () => {
    const s = session({ rateLimiter: new RateLimiter({ defaultDelayMs: 1200 }), pageBudgetMs: 300, concurrency: 1 });
    expect(await s.load({ url: url("/first"), extract: body })).toBe("fixture");
    const error = await s.load({ url: url("/late-paced"), extract: body }).catch((err) => err);
    expect(requested("/late-paced")).toHaveLength(0);
    expect(error.message).toContain("budget");
    await Bun.sleep(1300);
    expect(requested("/late-paced")).toHaveLength(0);
    expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
  });

  test("invalid URLs and selector timeouts release capacity for the next load", async () => {
    const s = session({ pageBudgetMs: 300, concurrency: 1 });
    await expect(s.load({ url: "invalid URL", extract: body })).rejects.toThrow();
    await expect(s.load({ url: url("/allowed"), waitForSelector: "#never", extract: body })).rejects.toThrow();
    expect(await s.load({ url: url("/next"), extract: body })).toBe("fixture");
  });
});
