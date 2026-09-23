/**
 * Detail-page enrichment (#36): a row the listing did not describe is followed
 * to its own page, and the description is taken from the `JobPosting` there.
 *
 * Nothing here touches the network. The per-board cases answer from the
 * detail pages committed under `fixtures/jsonld/`, which were captured over
 * plain HTTP — the transport enrichment uses — and the pacing case runs the
 * real `ScrapeClient` over a stubbed `fetch` with an injected clock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Window } from "happy-dom";
import {
  RateLimiter,
  RobotsCache,
  ScrapeClient,
  type FetchOptions,
  type FetchedPage,
  type RateLimiterClock,
} from "@schlessera/brain-scrape";

import { BuiltInAdapter } from "../src/adapters/builtin";
import type { BrowserJobRecord } from "../src/adapters/browser-base";
import { openDatabase } from "../src/db";
import { DEFAULT_DETAIL_DELAY_MS, createEnricher } from "../src/enrich";
import { jobsFromJsonLd } from "../src/jsonld";
import { ingestJobs } from "../src/scrape";
import type { RawJob, Source } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures");
const read = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), "utf-8");

/** A detail page with one `JobPosting` carrying `description`. */
function detailPage(description: string): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Platform Engineer",
    hiringOrganization: { "@type": "Organization", name: "Example Corp" },
    description,
  })}</script></head><body></body></html>`;
}

function job(source: Source, url: string, extra: Partial<RawJob> = {}): RawJob {
  return { source, source_id: url, title: "Platform Engineer", company: "Example Corp", url, source_url: url, ...extra };
}

/** An HTTP client that answers `getPage` from a function and records calls. */
function stubHttp(answer: (url: string) => string | Error | Promise<string>) {
  const requests: Array<{ url: string; opts: FetchOptions }> = [];
  return {
    requests,
    async getPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
      requests.push({ url, opts });
      const body = await answer(url);
      if (body instanceof Error) throw body;
      return { body, url };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Every board, against what it actually serves
// ---------------------------------------------------------------------------

describe("each board's stored rows carry the description its detail page has", () => {
  const captures = (
    JSON.parse(read("jsonld", "capture.json")) as {
      captures: Array<{ fixture: string; source: Source; url: string; transport: string }>;
    }
  ).captures;

  test("the detail fixtures cover every board whose listing has no description, over HTTP", () => {
    // The #33 re-measurement: builtin, nodesk, simplyhired, dice and remotelyde
    // stored no description at all; jobgether's API carries none either. Every
    // one but builtin (read off its own listing, below) has a detail capture.
    expect(captures.map((c): string => c.source).sort()).toEqual(
      ["dice", "jobgether", "nodesk", "remotelyde", "simplyhired"].sort()
    );
    for (const capture of captures) expect(capture.transport).toBe("http");
  });

  for (const capture of captures) {
    test(`${capture.source}: ${capture.fixture}`, async () => {
      const html = read("jsonld", capture.fixture);
      const expected = jobsFromJsonLd(html, { source: capture.source, pageUrl: capture.url }).jobs.find(
        (posting) => posting.description
      )?.description;
      expect(expected?.length).toBeGreaterThan(100);

      const http = stubHttp((url) => (url === capture.url ? html : new Error(`unexpected ${url}`)));
      const rows = [job(capture.source, capture.url)];
      const stats = await createEnricher(http).enrich({ source: capture.source, name: capture.source, jobs: rows });

      expect(stats).toMatchObject({ enriched: 1, failed: 0, truncated: 0 });
      const db = openDatabase(":memory:");
      try {
        ingestJobs(db, rows);
        const stored = db.query("SELECT description_text FROM jobs").get() as { description_text: string };
        expect(stored.description_text.length).toBeGreaterThan(100);
        expect(stored.description_text).toContain(expected!.slice(0, 40));
      } finally {
        db.close();
      }
    });
  }

  test("builtin: the listing's own ItemList describes each card, so no detail page is needed", () => {
    // Built In's detail pages sit behind the same challenge its listing does
    // over HTTP; its rendered listing already carries the description, in the
    // structured data the extractor used to ignore.
    const window = new Window({ url: "https://builtin.com/jobs/remote" });
    window.document.body.innerHTML =
      read("boards", "builtin", "rendered-card.html") + read("boards", "builtin", "listing-jsonld.html");
    const globals = globalThis as unknown as { document: unknown };
    const saved = globals.document;
    globals.document = window.document;
    let records: BrowserJobRecord[];
    try {
      records = (new BuiltInAdapter() as unknown as { extract(): BrowserJobRecord[] }).extract();
    } finally {
      globals.document = saved;
      window.close();
    }

    expect(records).toHaveLength(1);
    expect(records[0].description).toStartWith("Architect and operate scalable backend systems");
  });
});

// ---------------------------------------------------------------------------
// 2. What is not fetched
// ---------------------------------------------------------------------------

describe("rows that need no detail page are not fetched", () => {
  test("a row its listing described keeps that description and costs no request", async () => {
    const http = stubHttp(() => new Error("must not fetch"));
    const rows = [job("remoteok", "https://remoteok.example/1", { description: "<p>From the feed.</p>" })];

    const stats = await createEnricher(http).enrich({ source: "remoteok", name: "RemoteOK", jobs: rows });

    expect(http.requests).toEqual([]);
    expect(stats).toMatchObject({ enriched: 0, failed: 0, truncated: 0 });
    expect(rows[0].description).toBe("<p>From the feed.</p>");
  });

  test("a row already stored with a description is not fetched again, and spends no cap", async () => {
    const http = stubHttp(() => detailPage("Fetched."));
    const rows = [job("dice", "https://dice.example/1"), job("dice", "https://dice.example/2")];

    const stats = await createEnricher(http, { maxDetailPages: 1 }).enrich({
      source: "dice",
      name: "Dice",
      jobs: rows,
      isDescribed: (row) => row.url === "https://dice.example/1",
    });

    expect(http.requests.map((r) => r.url)).toEqual(["https://dice.example/2"]);
    expect(stats).toMatchObject({ enriched: 1, failed: 0, truncated: 0 });
  });

  test("the board's own page is followed, not the apply link", async () => {
    const http = stubHttp(() => detailPage("From the board."));
    const rows = [
      job("dice", "https://ats.example/apply/1", { source_url: "https://dice.example/job/1" }),
    ];

    await createEnricher(http).enrich({ source: "dice", name: "Dice", jobs: rows });

    expect(http.requests.map((r) => r.url)).toEqual(["https://dice.example/job/1"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Bounds: concurrency and the per-run cap
// ---------------------------------------------------------------------------

describe("concurrency is bounded and configurable", () => {
  async function maxInFlight(concurrency: number): Promise<{ max: number; done: number }> {
    let inFlight = 0;
    let max = 0;
    const http = stubHttp(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return detailPage("Fetched.");
    });
    const rows = Array.from({ length: 7 }, (_, i) => job("nodesk", `https://host${i}.example/job`));

    const stats = await createEnricher(http, { concurrency }).enrich({ source: "nodesk", name: "NoDesk", jobs: rows });
    return { max, done: stats.enriched };
  }

  test("no more than N detail requests are in flight", async () => {
    expect(await maxInFlight(3)).toEqual({ max: 3, done: 7 });
  });

  test("N is the configured value", async () => {
    expect(await maxInFlight(1)).toEqual({ max: 1, done: 7 });
  });

  test("the limit holds across boards enriched at the same time", async () => {
    let inFlight = 0;
    let max = 0;
    const http = stubHttp(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return detailPage("Fetched.");
    });
    const enricher = createEnricher(http, { concurrency: 2 });
    const board = (source: Source) =>
      enricher.enrich({
        source,
        name: source,
        jobs: Array.from({ length: 4 }, (_, i) => job(source, `https://${source}${i}.example/job`)),
      });

    await Promise.all([board("dice"), board("nodesk"), board("simplyhired")]);
    expect(max).toBe(2);
  });
});

describe("the per-run cap is reported when it truncates", () => {
  test("the rows past the cap are counted and named in the errors", async () => {
    const http = stubHttp(() => detailPage("Fetched."));
    const rows = Array.from({ length: 5 }, (_, i) => job("dice", `https://dice.example/${i}`));

    const stats = await createEnricher(http, { maxDetailPages: 2 }).enrich({ source: "dice", name: "Dice", jobs: rows });

    expect(http.requests).toHaveLength(2);
    expect(stats).toMatchObject({ enriched: 2, failed: 0, truncated: 3 });
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("Dice");
    expect(stats.errors[0]).toContain("3 jobs left without a description");
    expect(stats.errors[0]).toContain("cap of 2");
    // The truncated rows are still rows.
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.description)).toHaveLength(2);
  });

  test("the cap is one budget for the whole run, not one per board", async () => {
    const http = stubHttp(() => detailPage("Fetched."));
    const enricher = createEnricher(http, { maxDetailPages: 3 });
    const rows = (source: Source) => [job(source, `https://${source}.example/1`), job(source, `https://${source}.example/2`)];

    const first = await enricher.enrich({ source: "dice", name: "Dice", jobs: rows("dice") });
    const second = await enricher.enrich({ source: "nodesk", name: "NoDesk", jobs: rows("nodesk") });

    expect(first).toMatchObject({ enriched: 2, truncated: 0 });
    expect(second).toMatchObject({ enriched: 1, truncated: 1 });
  });

  test("across a run's boards the cap is dealt out in turn, not spent by the first board", async () => {
    // Measured live: with the cap handed out first come, first served, the
    // boards whose listings finished first took all of it and dice and
    // remotely.de got nothing, two runs in a row.
    const http = stubHttp(() => detailPage("Fetched."));
    const rows = (source: Source, n: number) =>
      Array.from({ length: n }, (_, i) => job(source, `https://${source}.example/${i}`));

    const stats = await createEnricher(http, { maxDetailPages: 4 }).enrichAll([
      { source: "remotelyde", name: "Remotely.de", jobs: rows("remotelyde", 5) },
      { source: "dice", name: "Dice", jobs: rows("dice", 1) },
      { source: "nodesk", name: "NoDesk", jobs: rows("nodesk", 3) },
    ]);

    expect(stats.map(({ enriched, truncated }) => ({ enriched, truncated }))).toEqual([
      { enriched: 2, truncated: 3 },
      { enriched: 1, truncated: 0 },
      { enriched: 1, truncated: 2 },
    ]);
  });

  test("a cap of 0 turns enrichment off, quietly", async () => {
    // Off is a setting, not a truncation: a run configured not to enrich does
    // not report every row as left behind.
    const http = stubHttp(() => detailPage("Fetched."));
    const stats = await createEnricher(http, { maxDetailPages: 0 }).enrich({
      source: "dice",
      name: "Dice",
      jobs: [job("dice", "https://dice.example/1")],
    });

    expect(http.requests).toEqual([]);
    expect(stats).toEqual({ enriched: 0, failed: 0, truncated: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// 4. Failures
// ---------------------------------------------------------------------------

describe("enrichment failures are counted, and lose nothing", () => {
  test("a failure is quoted by its cause, not by the error page it carried", async () => {
    // `ScrapeClient.getPage` puts the whole response body in its error; a
    // board's 404 page is not something a run report should carry.
    const http = stubHttp(
      () => new Error(`HTTP 404 from https://nodesk.example/x: <!doctype html><html>${"x".repeat(5000)}</html>`)
    );
    const stats = await createEnricher(http).enrich({
      source: "nodesk",
      name: "NoDesk",
      jobs: [job("nodesk", "https://nodesk.example/x")],
    });

    expect(stats.errors[0]).toContain("HTTP 404 from https://nodesk.example/x");
    expect(stats.errors[0]).not.toContain("<!doctype");
    expect(stats.errors[0].length).toBeLessThan(400);
  });

  test("a detail page that fails or carries no description is a counted failure, not a lost row", async () => {
    const http = stubHttp((url) => {
      if (url.endsWith("/down")) return new Error("HTTP 503");
      if (url.endsWith("/bare")) return "<html><body>No structured data here.</body></html>";
      return detailPage("The real description.");
    });
    const rows = [
      job("simplyhired", "https://simplyhired.example/down"),
      job("simplyhired", "https://simplyhired.example/bare"),
      job("simplyhired", "https://simplyhired.example/good"),
    ];

    const stats = await createEnricher(http).enrich({ source: "simplyhired", name: "SimplyHired", jobs: rows });

    expect(stats).toMatchObject({ enriched: 1, failed: 2, truncated: 0 });
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("SimplyHired");
    expect(stats.errors[0]).toContain("2 of 3 detail pages");
    expect(stats.errors[0]).toContain("HTTP 503");
    expect(rows.map((row) => row.description ?? null)).toEqual([null, null, "The real description."]);
    // The quoted cause is the error's first line, not the page it came with.
    expect(stats.errors[0]).toContain("no JobPosting description");

    // And every row is still stored.
    const db = openDatabase(":memory:");
    try {
      ingestJobs(db, rows);
      expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Pacing: the shared client's rate limiter schedules the detail fetches
// ---------------------------------------------------------------------------

describe("per-host pacing holds with enrichment on", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fakeClock(): RateLimiterClock & { waits: number[] } {
    let now = 1_000_000;
    const waits: number[] = [];
    return {
      waits,
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    };
  }

  async function pacedRun(fetchOptions?: FetchOptions) {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(String(input));
      return new Response(detailPage("Fetched."));
    }) as unknown as typeof fetch;
    const clock = fakeClock();
    const http = new ScrapeClient({
      rateLimiter: new RateLimiter({ clock }),
      robots: new RobotsCache({ fetcher: async () => ({ status: 404, body: "" }) }),
    });
    const rows = [1, 2, 3].map((i) => job("dice", `https://www.dice.example/job-detail/${i}`));

    const stats = await createEnricher(http, { concurrency: 3 }).enrich({
      source: "dice",
      name: "Dice",
      jobs: rows,
      fetchOptions,
    });
    return { stats, fetched, waits: clock.waits };
  }

  test("three concurrent detail fetches to one host are spaced by the limiter", async () => {
    const { stats, fetched, waits } = await pacedRun();
    expect(stats.enriched).toBe(3);
    expect(fetched).toHaveLength(3);
    expect(waits).toEqual([DEFAULT_DETAIL_DELAY_MS, DEFAULT_DETAIL_DELAY_MS]);
  });

  test("a board's own detail delay replaces the default", async () => {
    const { waits } = await pacedRun({ delayMs: 3000 });
    expect(waits).toEqual([3000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// 6. The run report
// ---------------------------------------------------------------------------

describe("runScrape reports enrichment per board", () => {
  async function run(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), "brain-enrich-report-"));
    try {
      const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/enrich-runner.ts"), mode, join(dir, "jobs.db")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout) as {
        report: { sources: Array<Record<string, unknown> & { errors: string[] }> };
        stored: Array<{ source_id: string; description_text: string | null }>;
        run: { status: string; cursor: string | null };
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("enriched and truncated rows are counted in the --json row", async () => {
    const { report, stored, run: logged } = await run("truncate");
    const row = report.sources[0];
    expect(row).toMatchObject({
      source: "remoteok",
      status: "ok",
      jobs_found: 2,
      jobs_enriched: 1,
      enrichment_failed: 0,
      enrichment_truncated: 1,
    });
    expect(row.errors.join("\n")).toContain("1 jobs left without a description");
    expect(stored.map((r) => r.description_text)).toEqual(["Fetched for job 1.", null]);
    // A finding about the rows does not hold back the listing's cursor.
    expect(logged).toMatchObject({ status: "completed", cursor: "2025-02-01T00:00:00.000Z" });
  });

  test("a failed detail page is counted, and the board and its rows survive", async () => {
    const { report, stored } = await run("fail");
    expect(report.sources[0]).toMatchObject({
      status: "ok",
      jobs_found: 2,
      jobs_enriched: 1,
      enrichment_failed: 1,
      enrichment_truncated: 0,
    });
    expect(stored).toHaveLength(2);
  });
});
