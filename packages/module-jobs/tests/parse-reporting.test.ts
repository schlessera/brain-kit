/**
 * A parser that matches nothing reports an error, not a zero (#37).
 *
 * The epic this belongs to survived for months because a run that had stopped
 * working looked exactly like a quiet day: `remoteineurope` reported 0 found
 * and 0 errors while its domain 301ed to another job site and answered 200
 * there. The repair is not "no rows means an error" — a board with genuinely
 * nothing to offer must still be allowed to say so, and the board that gave
 * this issue its shape (`remotelyde`, #146) produced eighteen rows and was
 * broken anyway. What a run reports is therefore a STATE, derived from what
 * each page turned out to be, and the count is only one of its inputs.
 *
 * Three things are proven here, in this order:
 *
 * 1. the ledger that derives the state, against adapters declared in this file
 *    — a test that borrows a real board to prove a claim about shared
 *    machinery acquires that board as a dependency and goes red when somebody
 *    repairs it;
 * 2. every real adapter, fed a page that is not its board's, reporting rather
 *    than shrugging — that one has to use the real boards, because it is a
 *    claim about each of them;
 * 3. the envelope `runScrape` and `--json` carry the state in.
 *
 * Keyless and offline throughout: the fixtures are the network, and the one
 * end-to-end run reaches for a Chrome that is not there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Window } from "happy-dom";

import {
  ScrapeClient,
  type BrowserSession,
  type FetchedPage,
  type FetchOptions,
  type PageRequest,
  type AdapterResult,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { BaseAdapter } from "../src/adapters/base";
import { getAdapter, runScrape } from "../src/scrape";
import { ALL_SOURCES, SOURCE_STATUSES, type Source, type RawJob } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures", "reporting");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** The page every board is fed to prove it reports what it cannot read. */
const INTERSTITIAL = fixture("interstitial.html");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Answers every read path from one body, and seals the raw one.
 *
 * `get` is what reaches robots.txt over the network before it has looked at
 * the URL, so it throws rather than being stubbed — the same seal, and the
 * same wording, as `board-fixtures.test.ts` and `jsonld-mapper.test.ts`.
 */
class StubClient extends ScrapeClient {
  readonly requests: string[] = [];

  constructor(
    /** One body for every URL, or one per URL for a board that reads several. */
    private readonly body: string | ((url: string) => string),
    /** Where the body claims to come from, for the redirect cases. */
    private readonly servedBy?: string
  ) {
    super();
  }

  override async getPage(url: string, _opts: FetchOptions = {}): Promise<FetchedPage> {
    this.requests.push(url);
    const body = typeof this.body === "function" ? this.body(url) : this.body;
    return { body, url: this.servedBy ?? url };
  }

  override async getText(url: string, opts: FetchOptions = {}): Promise<string> {
    return (await this.getPage(url, opts)).body;
  }

  override async getJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
    return JSON.parse((await this.getPage(url, opts)).body) as T;
  }

  override async get(url: string, _opts: FetchOptions = {}): Promise<Response> {
    throw new Error(
      `StubClient.get(${url}) — these tests answer from a fixture and must never ` +
        `reach the network. Add the read path you need to StubClient instead.`
    );
  }
}

/** A client whose every request throws, for the "nothing arrived" cases. */
class DeadClient extends ScrapeClient {
  constructor(private readonly cause: string) {
    super();
  }
  override async getPage(url: string): Promise<FetchedPage> {
    throw new Error(`${this.cause} (${url})`);
  }
  override async getText(url: string): Promise<string> {
    return (await this.getPage(url)).body;
  }
  override async getJson<T = unknown>(url: string): Promise<T> {
    return JSON.parse((await this.getPage(url)).body) as T;
  }
  override async get(url: string): Promise<Response> {
    throw new Error(`${this.cause} (${url})`);
  }
}

/** Run a page function over a body in a real DOM, with no Chrome. */
function inFixtureDom<T>(html: string, run: () => T): T {
  const window = new Window({ url: "https://example.test/" });
  window.document.body.innerHTML = html;
  const globals = globalThis as unknown as { document: unknown };
  const saved = globals.document;
  globals.document = window.document;
  try {
    return run();
  } finally {
    globals.document = saved;
    window.close();
  }
}

/** A browser board's context, serving one body to every page it opens. */
function browserContextServing(html: string): ScrapeContext {
  const browser: BrowserSession = {
    async load<T>(request: PageRequest<T>): Promise<T> {
      return inFixtureDom(html, request.extract);
    },
    async close() {},
  };
  return {
    http: new StubClient("a browser board must not reach for HTTP"),
    browser,
    log: () => {},
  };
}

/**
 * Run any board over one body, whichever kind of board it is.
 *
 * The HTTP boards and the browser boards are asserted through the same call,
 * because the guarantee #37 is about belongs to neither half of the registry.
 */
function serve(
  source: Source,
  body: string | ((url: string) => string),
  servedBy?: string
): Promise<AdapterResult<RawJob>> {
  const adapter = getAdapter(source);
  const ctx: ScrapeContext = adapter.needsBrowser
    ? browserContextServing(typeof body === "function" ? body("") : body)
    : { http: new StubClient(body, servedBy), log: () => {} };
  return adapter.scrape(ctx, { incremental: false });
}

// ---------------------------------------------------------------------------
// 1. The ledger, against boards that exist only here
// ---------------------------------------------------------------------------

/** One page, one URL, and whatever the test wants it to mean. */
class OnePageBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "One-page board";
  readonly tier = 1 as const;

  constructor(
    private readonly rows: number,
    private readonly opts: { declaredEmpty?: boolean; continuation?: boolean } = {}
  ) {
    super();
  }

  protected async scrapePages() {
    const url = "https://board.test/jobs";
    const pages = this.ledger();
    const page = await this.http.getPage(url);
    pages.read(url, this.rows, { ...this.opts, from: page.url });
    return this.makeResult(rowsOf(this.rows), pages);
  }
}

/** A board that fetches and never says what it found. */
class SilentBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "Silent board";
  readonly tier = 1 as const;

  protected async scrapePages() {
    await this.http.getPage("https://board.test/jobs");
    return this.makeResult([], this.ledger());
  }
}

/**
 * A paginating board: page 1 is the listing, the rest are its continuation.
 *
 * `rows` is what each page yields, in order. `firstPageThrows` makes page 1
 * fail while the loop carries on, which is what `remotelyde` does.
 */
class PagingBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "Paging board";
  readonly tier = 1 as const;

  constructor(
    private readonly rows: number[],
    private readonly opts: { firstPageThrows?: boolean } = {}
  ) {
    super();
  }

  protected async scrapePages() {
    const pages = this.ledger();
    let total = 0;
    for (const [index, rows] of this.rows.entries()) {
      const page = index + 1;
      const url = `https://board.test/jobs/page/${page}`;
      if (page === 1 && this.opts.firstPageThrows) {
        pages.unreachable(url, new Error("page 1 died"));
        continue;
      }
      await this.http.getPage(url);
      pages.read(url, rows, { continuation: page > 1 });
      total += rows;
    }
    return this.makeResult(rowsOf(total), pages);
  }
}

/** A board reading several independent listings, each with its own outcome. */
class MixedBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "Mixed board";
  readonly tier = 1 as const;

  constructor(private readonly outcomes: Array<"empty" | "failed" | "unrecognised">) {
    super();
  }

  protected async scrapePages() {
    const pages = this.ledger();
    for (const [index, outcome] of this.outcomes.entries()) {
      const url = `https://board.test/category/${index + 1}`;
      if (outcome === "failed") {
        pages.unreachable(url, new Error(`page ${index + 1} died`));
        continue;
      }
      await this.http.getPage(url);
      pages.read(url, 0, { declaredEmpty: outcome === "empty" });
    }
    return this.makeResult([], pages);
  }
}

/** A board whose every page throws. */
class UnreachableBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "Unreachable board";
  readonly tier = 1 as const;

  protected async scrapePages() {
    const pages = this.ledger();
    for (const url of ["https://board.test/1", "https://board.test/2"]) {
      try {
        await this.http.getPage(url);
      } catch (err) {
        pages.unreachable(url, err);
      }
    }
    return this.makeResult([], pages);
  }
}

/** `n` rows that `ingestJobs` would accept. Only the count matters here. */
function rowsOf(n: number) {
  return Array.from({ length: n }, (_v, i) => ({
    source: "remoteok" as const,
    source_id: `row-${i}`,
    title: `Role ${i}`,
    company: "Example Corp",
  }));
}

/** Run one of the boards declared above over a body. */
const runBoard = (adapter: BaseAdapter, body = "<html><body>a page</body></html>") =>
  adapter.scrape({ http: new StubClient(body), log: () => {} }, { incremental: false });

describe("the page ledger", () => {
  test("rows are `ok`, and nothing is reported", async () => {
    const result = await runBoard(new OnePageBoard(3));
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  test("a page that does not say it is empty and yields nothing is `unparseable`", async () => {
    const result = await runBoard(new OnePageBoard(0));
    expect(result.status).toBe("unparseable");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("parsed 0 jobs");
    expect(result.errors[0]).toContain("https://board.test/jobs");
  });

  test("a page that DOES say it is empty is `empty`, with nothing reported", async () => {
    const result = await runBoard(new OnePageBoard(0, { declaredEmpty: true }));
    expect(result.status).toBe("empty");
    expect(result.errors).toEqual([]);
  });

  test("a continuation of a page that parsed is the end of the list", async () => {
    const result = await runBoard(new PagingBoard([2, 0]));
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  test("a continuation of a page that did NOT parse is not excused", async () => {
    // The flag is a claim, not a fact: a loop that keeps going after its first
    // page threw would otherwise excuse page 2 for a challenge page it has no
    // reason to excuse. The ledger only honours `continuation` once some page
    // in the run has actually parsed.
    const result = await runBoard(new PagingBoard([0, 0], { firstPageThrows: true }));
    expect(result.status).toBe("unparseable");
    expect(result.errors[0]).toContain("page 1 died");
    expect(result.errors[1]).toContain("parsed 0 jobs");
  });

  test("a board that fetched and reported no page at all is `not_run`", async () => {
    // The honest answer for an adapter that never read anything, and a loud
    // one for an adapter that forgot to say what it read.
    const result = await runBoard(new SilentBoard());
    expect(result.status).toBe("not_run");
  });

  test("one page that failed denies the board a clean `empty`", async () => {
    // A board with four empty categories and one that threw used to come back
    // as `empty` with an error beside it — a zero that the run log then wrote
    // down as `completed`. A board that could not read one of its own
    // listings does not know whether it has postings there.
    const result = await runBoard(new MixedBoard(["empty", "failed", "empty"]));

    expect(result.status).toBe("unparseable");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("page 2 died");
  });

  test("but every page failing is still `not_run`, not `unparseable`", async () => {
    const result = await runBoard(new MixedBoard(["failed", "failed"]));
    expect(result.status).toBe("not_run");
  });

  test("a board whose every page threw is `not_run`, with each throw named", async () => {
    const result = await new UnreachableBoard().scrape({ http: new DeadClient("robots.txt disallows this path"), log: () => {} }, {});

    expect(result.status).toBe("not_run");
    expect(result.errors).toHaveLength(2);
    for (const error of result.errors) expect(error).toContain("robots.txt disallows");
  });

  test("a body served by another site is reported even when it parsed", async () => {
    // The `remoteineurope` shape: a 301 to somewhere else answers 200 and
    // parses like a healthy page. Rows scraped off somebody else's markup
    // under this board's name are worse than no rows at all, so this is
    // reported whatever the count is.
    const adapter = new OnePageBoard(4);
    const result = await adapter.scrape({
        http: new StubClient("<html></html>", "https://another-board.test/jobs"),
        log: () => {},
      }, {});

    expect(result.status).toBe("ok");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("served by another-board.test after a redirect");
  });

  test("apex-to-www and subdomain hops are not redirects worth reporting", async () => {
    // Every one of these boards does one of these routinely; a hop to a
    // different registrable name is the one that means something.
    for (const servedBy of ["https://www.board.test/jobs", "https://eu.board.test/jobs"]) {
      const result = await new OnePageBoard(2).scrape({ http: new StubClient("<html></html>", servedBy), log: () => {} }, {});
      expect(result.errors).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every adapter, against a page that is not its board's
// ---------------------------------------------------------------------------

describe("every adapter reports a page it cannot read", () => {
  // The acceptance criterion is per-adapter, so this is the one place the real
  // registry is used. `ALL_SOURCES` rather than a list, so a board added later
  // is covered the day it is added rather than the day somebody remembers.
  test.each([...ALL_SOURCES])("%s", async (source) => {
    const result = await serve(source, INTERSTITIAL);

    expect(result.items).toEqual([]);
    // The whole of #37 in one assertion: zero rows off a non-empty page that
    // is not this board's can never be silence.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.status).not.toBe("ok");
    expect(result.status).not.toBe("empty");
  });

  test("no adapter can report zero rows and zero errors from a non-empty page", async () => {
    // The same claim as an invariant over the whole registry, because the
    // per-board assertions above each pass for a board that returns early.
    const silent: Source[] = [];
    for (const source of ALL_SOURCES) {
      const result = await serve(source, INTERSTITIAL);
      if (result.items.length === 0 && result.errors.length === 0) silent.push(source);
    }
    expect(silent).toEqual([]);
  });

  test("the challenge page is not empty, and is nobody's listing", async () => {
    // Without this the sweep above passes for the wrong reason: an empty
    // string would satisfy it too, and would be testing something else.
    expect(INTERSTITIAL.length).toBeGreaterThan(200);
    expect(INTERSTITIAL).toContain("Verifying you are human");
    expect(INTERSTITIAL).not.toContain("/job/");
  });
});

// ---------------------------------------------------------------------------
// 3. A recognised empty listing, next to the same envelope having drifted
// ---------------------------------------------------------------------------

/**
 * Same envelope, same row count, opposite verdicts.
 *
 * `empty` is the board's own statement that it has no postings; `drifted` is
 * the same envelope carrying records whose fields have been renamed. Both
 * produce zero rows, which is exactly why the count cannot be what decides.
 */
const EMPTY_AND_DRIFTED: Array<{ source: Source; empty: string; drifted?: string }> = [
  { source: "remoteok", empty: "remoteok-empty.json", drifted: "remoteok-drifted.json" },
  { source: "remotive", empty: "remotive-empty.json", drifted: "remotive-drifted.json" },
  {
    source: "workingnomads",
    empty: "workingnomads-empty.json",
    drifted: "workingnomads-drifted.json",
  },
  // The feed carries no records to rename: what it has instead of a drifted
  // variant is the challenge page in the sweep above, which has no channel.
  { source: "weworkremotely", empty: "weworkremotely-empty.rss" },
  { source: "jobgether", empty: "jobgether-empty.json" },
];

describe("a board that says it has no postings is believed", () => {
  for (const { source, empty, drifted } of EMPTY_AND_DRIFTED) {
    test(`${source}: its own envelope, carrying nothing, is a zero`, async () => {
      const result = await serve(source, fixture(empty));

      expect(result.items).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.status).toBe("empty");
    });

    if (!drifted) continue;

    test(`${source}: the same envelope with renamed fields is not`, async () => {
      const body = fixture(drifted);
      // The records are there — this is not the empty file with a different
      // name — and the adapter still reads nothing off them.
      expect(body.length).toBeGreaterThan(fixture(empty).length);
      const result = await serve(source, body);

      expect(result.items).toEqual([]);
      expect(result.status).toBe("unparseable");
      expect(result.errors.join("\n")).toContain("parsed 0 jobs");
    });
  }

  test("remoteok: valid JSON that is not its feed is drift, not an empty feed", async () => {
    // `{"error":"maintenance"}` parses, carries no entries, and produces the
    // same zero rows as a feed holding only its legal notice. What separates
    // them is the envelope: an array, or not.
    const result = await serve("remoteok", fixture("remoteok-maintenance.json"));

    expect(result.items).toEqual([]);
    expect(result.status).toBe("unparseable");
  });

  test("weworkremotely: a full feed whose item tags grew an attribute is drift", async () => {
    // `parseRssItems` matches `<item>` by bare tag, so this feed reads as no
    // items at all — and it has a channel, so an empty check that stopped at
    // the channel would call two live postings an empty board. It is the same
    // defect #33 found in remotely.de's JSON-LD, one document type over.
    const body = fixture("weworkremotely-attributed-items.rss");
    expect(body).toContain("<item xml:base=");
    expect(body).not.toContain("<item>");

    const result = await serve("weworkremotely", body);

    expect(result.items).toEqual([]);
    expect(result.status).toBe("unparseable");
    expect(result.errors.join("\n")).toContain("parsed 0 jobs");
  });

  test("remoteok: a feed of unusable records is corrupt, not empty", async () => {
    // The records are there. A filter that dropped everything it could not use
    // would leave nothing behind and report a board with no jobs in it.
    const result = await serve("remoteok", fixture("remoteok-null-records.json"));

    expect(result.items).toEqual([]);
    expect(result.status).toBe("unparseable");
  });

  test("remotive: a category that arrived and could not be read is not outvoted", async () => {
    // One category holds a posting whose `job_type` is an object, so mapping
    // it throws AFTER the response arrived; the other four answer with an
    // empty `jobs` array. The four must not decide the run on their own.
    const broken = fixture("remotive-unusable-record.json");
    const empty = fixture("remotive-empty.json");
    const result = await serve("remotive", (url) =>
      url.includes("category=data") ? broken : empty
    );

    expect(result.items).toEqual([]);
    expect(result.status).toBe("unparseable");
    expect(result.errors.join("\n")).toContain("category=data");
  });

  test("jobgether's captured endpoint, with its fields renamed, is drift", async () => {
    // Built from the real capture rather than from a constructed envelope, so
    // the drift case for this board is the shape the site actually serves.
    const captured = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "boards", "jobgether", "api-v1-jobs.json"), "utf-8")
    ) as { jobs: Array<Record<string, unknown>> };
    expect(captured.jobs.length).toBeGreaterThan(0);

    for (const offer of captured.jobs) {
      offer.name = offer.title;
      offer.employer = offer.company;
      delete offer.title;
      delete offer.company;
    }
    const result = await serve("jobgether", JSON.stringify(captured));

    expect(result.items).toEqual([]);
    expect(result.status).toBe("unparseable");
  });
});

// ---------------------------------------------------------------------------
// 3b. The other direction: a healthy run stays quiet
// ---------------------------------------------------------------------------

describe("an ordinary run raises no alarm", () => {
  // Every assertion above pushes towards reporting more. These are the ones
  // that keep it from reporting everything: a change that made `unparseable`
  // the answer to any awkward response would pass the whole suite above and
  // fail here.

  test("remotive: one empty category among four healthy ones is not an error", async () => {
    const result = await serve("remotive", (url) =>
      url.includes("category=data")
        ? fixture("remotive-empty.json")
        : '{"jobs":[{"id":1,"title":"Staff Platform Engineer","company_name":"Example Corp"}]}'
    );

    expect(result.items).toHaveLength(4);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  test("remotelyde: running out of pages is the end of the list, not a failure", async () => {
    // Page 1 carries one card; page 2 carries none, which stops the loop.
    // This is the only board that paginates, and the only place `continuation`
    // is claimed in production code.
    const result = await serve("remotelyde", (url) =>
      url.endsWith("/remote-jobs")
        ? '<a href="/job/a"><h3>Staff Platform Engineer</h3><span class="truncate">Example Corp</span></a>'
        : "<html><body>no cards here</body></html>"
    );

    expect(result.items).toHaveLength(1);
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  test("remoteok: an envelope holding only its legal notice is a quiet zero", async () => {
    const result = await serve("remoteok", "[]");
    expect(result.status).toBe("empty");
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The envelope the run report and `--json` carry it in
// ---------------------------------------------------------------------------

const BROWSER_VARS = ["SCRAPE_CHROME_PATH", "SCRAPE_CHROME_URL", "CHROME_CDP_URL"] as const;
const previous = Object.fromEntries(BROWSER_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of BROWSER_VARS) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the run report", () => {
  test("carries the state per source, and survives JSON", async () => {
    // The only status a keyless end-to-end run can produce: no Chrome, so the
    // three browser boards read nothing. What it proves is the wiring —
    // adapter status to report row to the `{ report }` envelope `--json`
    // prints — which is the same wiring for all four values.
    delete process.env.SCRAPE_CHROME_URL;
    delete process.env.CHROME_CDP_URL;
    process.env.SCRAPE_CHROME_PATH = join(tmpdir(), "no-such-chrome-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "brain-jobs-report-"));
    try {
      const report = await runScrape({
        dbPath: join(dir, "jobs.db"),
        sources: ["builtin", "nodesk", "dice"],
        incremental: false,
        dryRun: true,
      });

      // Every selected board has a row. A board that fell out of the report
      // would read as one that was never asked for.
      expect(report.sources.map((s) => s.source).sort()).toEqual(["builtin", "dice", "nodesk"]);
      for (const entry of report.sources) {
        expect(entry.status).toBe("not_run");
        expect(entry.jobs_found).toBe(0);
        expect(entry.errors.length).toBeGreaterThan(0);
      }

      // `--json` prints `{ report }` and nothing else, so this is the shape a
      // consumer sees. See docs/integration-contract.md.
      const json = JSON.parse(JSON.stringify({ report })) as {
        report: { sources: Array<{ source: string; status: string }>; total_errors: string[] };
      };
      expect(json.report.sources[0]).toHaveProperty("status", "not_run");
      expect(json.report.total_errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the four states are the four the contract documents", () => {
    expect([...SOURCE_STATUSES]).toEqual(["ok", "empty", "unparseable", "not_run"]);
  });

  test("all four are reachable, and no two of them mean the same thing", async () => {
    const reached = new Set<string>();
    reached.add((await runBoard(new OnePageBoard(2))).status);
    reached.add((await runBoard(new OnePageBoard(0, { declaredEmpty: true }))).status);
    reached.add((await runBoard(new OnePageBoard(0))).status);
    reached.add((await runBoard(new SilentBoard())).status);
    expect([...reached].sort()).toEqual([...SOURCE_STATUSES].sort());
  });
});
