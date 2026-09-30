import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { Database } from "bun:sqlite";
import * as scraping from "@schlessera/brain-scrape";
import { ScrapeClient, runAdapters, type BrowserSession, type FetchedPage, type FetchOptions } from "@schlessera/brain-scrape";
import { getAdapter, runScrape } from "../src/scrape.js";
import { ALL_SOURCES, type RawJob, type Source } from "../src/types.js";

const fixture = (path: string) => readFileSync(join(import.meta.dir, "fixtures", path), "utf8");
const listing: Record<Source, string> = {
  remoteok: JSON.stringify([{ id: "fixture-1", position: "Engineer", company: "Example Corp", date: "2025-01-01T00:00:00.000Z" }]),
  remotive: JSON.stringify({ jobs: [{ id: 1, title: "Engineer", company_name: "Example Corp", url: "https://remotive.com/job/1" }] }),
  weworkremotely: '<rss><channel><item><title>Example Corp: Engineer</title><guid>fixture-1</guid><link>https://weworkremotely.com/job/1</link></item></channel></rss>',
  workingnomads: JSON.stringify([{ title: "Engineer", company_name: "Example Corp", url: "https://workingnomads.com/job/go/fixture-1/" }]),
  jobgether: fixture("boards/jobgether/api-v1-jobs.json"),
  simplyhired: fixture("boards/simplyhired/listing-card.html"),
  remotelyde: fixture("boards/remotelyde/listing-row-cards.html"),
  builtin: fixture("boards/builtin/rendered-card.html"),
  nodesk: fixture("boards/nodesk/rendered-card.html"),
  dice: fixture("boards/dice/rendered-card.html"),
};

class FixtureClient extends ScrapeClient {
  readonly requests: Array<{ url: string; options: FetchOptions }> = [];
  constructor(private readonly body: string | Error) { super(); }
  override async getPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
    this.requests.push({ url, options });
    if (this.body instanceof Error) throw this.body;
    return { body: this.body, url };
  }
  override async getText(url: string, options?: FetchOptions) { return (await this.getPage(url, options)).body; }
  override async getJson<T>(url: string, options?: FetchOptions): Promise<T> { return JSON.parse(await this.getText(url, options)) as T; }
  override async get(): Promise<Response> { throw new Error("FixtureClient must not dispatch a network request"); }
}

function fixtureBrowser(body: string) {
  const requests: string[] = [];
  let closed = 0;
  const browser: BrowserSession = {
    async load(request) {
      requests.push(request.url);
      const window = new Window({ url: request.url });
      window.document.body.innerHTML = body;
      const saved = globalThis.document;
      globalThis.document = window.document as unknown as Document;
      try { return request.extract(); }
      finally { globalThis.document = saved; window.close(); }
    },
    async close() { closed++; },
  };
  return { browser, requests, closed: () => closed };
}

describe("real job boards through the shared runner", () => {
  for (const source of ALL_SOURCES) {
    test(`${source} produces nonempty domain items through SiteAdapter`, async () => {
      const adapter = getAdapter(source);
      const http = new FixtureClient(listing[source]);
      const chrome = fixtureBrowser(listing[source]);
      const outcomes = await runAdapters<RawJob>({
        adapters: [adapter],
        client: http,
        browser: chrome.browser,
        optionsFor: () => ({ incremental: false, queries: ["fixture engineer"] }),
      });
      expect(outcomes[0].status).toBe("ok");
      expect(outcomes[0].items.length).toBeGreaterThan(0);
      expect(outcomes[0].items.every((item) => item.source === source && item.title.length > 0)).toBe(true);
      expect(outcomes[0].id).toBe(source);
      expect(adapter.needsBrowser ? chrome.requests.length : http.requests.length).toBeGreaterThan(0);
      expect(chrome.closed()).toBe(0); // Caller-owned transports stay open.
    });
  }

  for (const [name, body, status] of [
    ["positive empty", "[]", "empty"],
    ["unrecognized records", '[{"renamed_position":"Engineer"}]', "unparseable"],
    ["unavailable transport", new Error("fixture transport unavailable"), "not_run"],
  ] as const) {
    test(`RemoteOK preserves ${name}`, async () => {
      const http = new FixtureClient(body);
      const [outcome] = await runAdapters<RawJob>({
        adapters: [getAdapter("remoteok")], client: http, browser: false,
      });
      expect(outcome.status).toBe(status);
      expect(outcome.items).toEqual([]);
      expect(http.requests.length).toBeGreaterThan(0);
      if (status === "empty") expect(outcome.errors).toEqual([]);
      else expect(outcome.errors.length).toBeGreaterThan(0);
    });
  }

  test("cursor/query/fetch inputs reach real HTTP adapters without lowering board pacing", async () => {
    const http = new FixtureClient(listing.remoteok);
    const [outcome] = await runAdapters<RawJob>({
      adapters: [getAdapter("remoteok")], client: http, browser: false,
      optionsFor: () => ({ incremental: true, cursor: "2026-01-01T00:00:00.000Z" }),
    });
    expect(outcome.items.length).toBeGreaterThan(0);
    expect(outcome.cursor).toBe("2026-01-01T00:00:00.000Z");
    const queries = new FixtureClient(listing.simplyhired);
    await runAdapters<RawJob>({
      adapters: [getAdapter("simplyhired")], client: queries, browser: false,
      optionsFor: () => ({ queries: ["fixture role"], proxy: "http://proxy.example:3128", fetch: { delayMs: 1, headers: { "X-Fixture": "yes" } } }),
    });
    expect(queries.requests).toHaveLength(1);
    expect(queries.requests[0].url).toContain("q=fixture%20role");
    expect(queries.requests[0].options).toMatchObject({ delayMs: 3000, proxy: "http://proxy.example:3128", headers: { "X-Fixture": "yes" } });
    await runAdapters<RawJob>({
      adapters: [getAdapter("simplyhired")], client: queries, browser: false,
      optionsFor: () => ({ queries: ["fixture role"], fetch: { delayMs: 6000 } }),
    });
    expect(queries.requests).toHaveLength(2);
    expect(queries.requests[1].options.delayMs).toBe(6000);
  });

  test("unavailable browser/proxy never invoke requesting real boards; later HTTP still runs", async () => {
    const browserBoard = getAdapter("builtin");
    const proxied = getAdapter("remoteok");
    Object.defineProperty(proxied, "needsProxy", { value: true });
    const browserCall = spyOn(browserBoard, "scrape");
    const proxyCall = spyOn(proxied, "scrape");
    try {
      const outcomes = await runAdapters({
        adapters: [browserBoard, proxied, getAdapter("workingnomads")], client: new FixtureClient(listing.workingnomads), browser: false,
      });
      expect(browserCall).toHaveBeenCalledTimes(0);
      expect(proxyCall).toHaveBeenCalledTimes(0);
      expect(outcomes.map(({ status }) => status)).toEqual(["not_run", "not_run", "ok"]);
      expect(outcomes[2].items.length).toBeGreaterThan(0);
      const available = await runAdapters({
        adapters: [proxied], client: new FixtureClient(listing.remoteok), browser: false,
        optionsFor: () => ({ proxy: "http://proxy.example:3128" }),
      });
      expect(proxyCall).toHaveBeenCalledTimes(1);
      expect(available[0].status).toBe("ok");
      expect(available[0].items.length).toBeGreaterThan(0);
    } finally { browserCall.mockRestore(); proxyCall.mockRestore(); }
  });

  test("the production jobs orchestration invokes runAdapters and keeps every source", async () => {
    const shared = spyOn(scraping, "runAdapters");
    const get = spyOn(ScrapeClient.prototype, "get").mockImplementation(async (url) => {
      if (url.startsWith("https://remoteok.com/")) throw new Error("fixture failed source");
      if (url.startsWith("https://www.workingnomads.com/")) return new Response(listing.workingnomads);
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const dir = mkdtempSync(join(tmpdir(), "jobs-shared-runner-"));
    try {
      const report = await runScrape({ dbPath: join(dir, "jobs.db"), sources: ["remoteok", "workingnomads"], enrichment: { maxDetailPages: 0 } });
      expect(shared).toHaveBeenCalledTimes(1);
      expect(report.sources.map(({ source, status, jobs_found }) => ({ source, status, jobs_found }))).toEqual([
        { source: "remoteok", status: "not_run", jobs_found: 0 },
        { source: "workingnomads", status: "ok", jobs_found: 1 },
      ]);
      expect(report.sources[0].errors.join(" ")).toContain("fixture failed source");
    } finally { shared.mockRestore(); get.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("production enrichment preserves the board host boundary, proxy and fetch floor", async () => {
    const requests: Array<{ url: string; options: FetchOptions }> = [];
    const get = spyOn(ScrapeClient.prototype, "get").mockImplementation(async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "https://jobgether.com/api/v1/jobs") return new Response(JSON.stringify({ jobs: [
        { id: "owned", title: "Engineer", company: "Example Corp", url: "https://jobgether.com/offer/owned" },
        { id: "external", title: "Engineer", company: "Example Corp", url: "https://apply.example/offer/external" },
      ] }));
      return new Response('<script type="application/ld+json">{"@type":"JobPosting","description":"Fixture full description."}</script>');
    });
    const dir = mkdtempSync(join(tmpdir(), "jobs-shared-enrichment-"));
    try {
      const dbPath = join(dir, "jobs.db");
      const report = await runScrape({ dbPath, sources: ["jobgether"], proxy: "http://proxy.example:3128" });
      expect(requests.map(({ url }) => url)).toEqual(["https://jobgether.com/api/v1/jobs", "https://jobgether.com/offer/owned"]);
      expect(report.sources[0]).toMatchObject({ status: "ok", jobs_found: 2, jobs_enriched: 1, enrichment_failed: 0 });
      for (const request of requests) expect(request.options).toMatchObject({ proxy: "http://proxy.example:3128", delayMs: 2000 });
      const stored = new Database(dbPath);
      try {
        expect(stored.query("SELECT source_id, description_text FROM jobs ORDER BY source_id").all()).toEqual([
          { source_id: "external", description_text: null },
          { source_id: "owned", description_text: "Fixture full description." },
        ]);
      } finally { stored.close(); }
    } finally { get.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("production closes its database when source setup fails", async () => {
    const close = spyOn(Database.prototype, "close");
    const dir = mkdtempSync(join(tmpdir(), "jobs-shared-db-failure-"));
    try {
      await expect(runScrape({ dbPath: join(dir, "jobs.db"), sources: ["invalid-fixture-source" as Source] })).rejects.toThrow("Unknown source");
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
