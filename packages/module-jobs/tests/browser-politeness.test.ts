import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { ScrapeClient } from "@schlessera/brain-scrape";
import { BuiltInAdapter } from "../src/adapters/builtin.js";
import { openDatabase } from "../src/db.js";
import { runScrape } from "../src/scrape.js";

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync);
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Jobs browser politeness requires real Chrome");
if (!executablePath) console.warn("Skipping jobs browser politeness: no Chrome installed");

describe.skipIf(!executablePath)("jobs-owned browser policy (real runner and Chrome)", () => {
  let chrome: Browser;
  let origin: ReturnType<typeof Bun.serve>;
  let hits: Array<{ path: string; at: number }>;
  const html = readFileSync(join(import.meta.dir, "fixtures/boards/builtin/rendered-card.html"), "utf8");
  beforeAll(async () => {
    chrome = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push({ path, at: performance.now() });
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /denied\nCrawl-delay: 1\n");
      if (path === "/http") return new Response("[]", { headers: { "content-type": "application/json" } });
      return new Response(html, { headers: { "content-type": "text/html" } });
    } });
  });
  afterAll(async () => { await chrome?.close(); origin?.stop(true); });

  async function run(path: string, mixed: boolean) {
    hits = [];
    const dir = mkdtempSync(join(tmpdir(), "jobs-browser-policy-"));
    const saved = { url: process.env.SCRAPE_CHROME_URL, respect: process.env.SCRAPE_RESPECT_ROBOTS };
    process.env.SCRAPE_CHROME_URL = `http://127.0.0.1:${new URL(chrome.wsEndpoint()).port}`;
    // This legacy HTTP setting must not grant new blanket browser permission.
    if (!mixed) process.env.SCRAPE_RESPECT_ROBOTS = "false";
    else delete process.env.SCRAPE_RESPECT_ROBOTS;
    const urls = spyOn(BuiltInAdapter.prototype as unknown as { urls(): string[] }, "urls").mockReturnValue([`${origin.url.origin}${path}`]);
    const get = ScrapeClient.prototype.get;
    const route = spyOn(ScrapeClient.prototype, "get").mockImplementation(function (this: ScrapeClient, url, opts) {
      return get.call(this, url.startsWith("https://remoteok.com/") ? `${origin.url.origin}/http` : url, opts);
    });
    try {
      const dbPath = join(dir, "jobs.db");
      const report = await runScrape({ dbPath, sources: mixed ? ["remoteok", "builtin"] : ["builtin"], dryRun: mixed });
      const db = openDatabase(dbPath);
      const stored = db.query("SELECT status, error FROM scrape_runs WHERE source = 'builtin' ORDER BY id DESC LIMIT 1").get();
      db.close();
      return { report, stored };
    } finally {
      route.mockRestore(); urls.mockRestore();
      if (saved.url === undefined) delete process.env.SCRAPE_CHROME_URL; else process.env.SCRAPE_CHROME_URL = saved.url;
      if (saved.respect === undefined) delete process.env.SCRAPE_RESPECT_ROBOTS; else process.env.SCRAPE_RESPECT_ROBOTS = saved.respect;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("denial reports not_run and persists failed despite the HTTP-only opt-out", async () => {
    const { report, stored } = await run("/denied", false);
    expect(hits.filter((hit) => hit.path === "/denied")).toHaveLength(0);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].status).toBe("not_run");
    expect(report.sources[0].jobs_found).toBe(0);
    expect(report.sources[0].errors.join(" ")).toContain("robots.txt disallows");
    expect(stored).toEqual({ status: "failed", error: report.sources[0].errors.join("; ") });
  });

  test("production HTTP/browser orchestration shares robots and Crawl-delay", async () => {
    const { report } = await run("/browser", true);
    const http = hits.filter((hit) => hit.path === "/http");
    const browser = hits.filter((hit) => hit.path === "/browser");
    expect(http).toHaveLength(1);
    expect(browser).toHaveLength(1);
    expect(Math.abs(browser[0].at - http[0].at)).toBeGreaterThanOrEqual(850);
    expect(hits.filter((hit) => hit.path === "/robots.txt")).toHaveLength(1);
    expect(report.sources.find((source) => source.source === "builtin")?.jobs_found).toBeGreaterThan(0);
  });
});
