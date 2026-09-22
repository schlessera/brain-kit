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
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { BaseAdapter } from "../src/adapters/base";
import { getAdapter, runScrape } from "../src/scrape";
import { ALL_SOURCES, SOURCE_STATUSES, type ScrapeResult, type Source } from "../src/types";

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
    private readonly body: string,
    /** Where the body claims to come from, for the redirect cases. */
    private readonly servedBy?: string
  ) {
    super();
  }

  override async getPage(url: string, _opts: FetchOptions = {}): Promise<FetchedPage> {
    this.requests.push(url);
    return { body: this.body, url: this.servedBy ?? url };
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
function serve(source: Source, body: string, servedBy?: string): Promise<ScrapeResult> {
  const adapter = getAdapter(source);
  const ctx: ScrapeContext = adapter.needsBrowser
    ? browserContextServing(body)
    : { http: new StubClient(body, servedBy), log: () => {} };
  return adapter.bind(ctx).scrape({ incremental: false });
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

  async scrape() {
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

  async scrape() {
    await this.http.getPage("https://board.test/jobs");
    return this.makeResult([], this.ledger());
  }
}

/** A board whose every page throws. */
class UnreachableBoard extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "Unreachable board";
  readonly tier = 1 as const;

  async scrape() {
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
  adapter.bind({ http: new StubClient(body), log: () => {} }).scrape({ incremental: false });

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

  test("a continuation that yields nothing is the end of the list, not a failure", async () => {
    // Only pagination may claim this, and only because the page before it
    // parsed. A board's second CATEGORY is not a continuation of its first.
    const result = await runBoard(new OnePageBoard(0, { continuation: true }));
    expect(result.status).toBe("empty");
    expect(result.errors).toEqual([]);
  });

  test("a board that fetched and reported no page at all is `not_run`", async () => {
    // The honest answer for an adapter that never read anything, and a loud
    // one for an adapter that forgot to say what it read.
    const result = await runBoard(new SilentBoard());
    expect(result.status).toBe("not_run");
  });

  test("a board whose every page threw is `not_run`, with each throw named", async () => {
    const result = await new UnreachableBoard()
      .bind({ http: new DeadClient("robots.txt disallows this path"), log: () => {} })
      .scrape();

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
    const result = await adapter
      .bind({
        http: new StubClient("<html></html>", "https://another-board.test/jobs"),
        log: () => {},
      })
      .scrape();

    expect(result.status).toBe("ok");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("served by another-board.test after a redirect");
  });

  test("apex-to-www and subdomain hops are not redirects worth reporting", async () => {
    // Every one of these boards does one of these routinely; a hop to a
    // different registrable name is the one that means something.
    for (const servedBy of ["https://www.board.test/jobs", "https://eu.board.test/jobs"]) {
      const result = await new OnePageBoard(2)
        .bind({ http: new StubClient("<html></html>", servedBy), log: () => {} })
        .scrape();
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

    expect(result.jobs).toEqual([]);
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
      if (result.jobs.length === 0 && result.errors.length === 0) silent.push(source);
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

      expect(result.jobs).toEqual([]);
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

      expect(result.jobs).toEqual([]);
      expect(result.status).toBe("unparseable");
      expect(result.errors.join("\n")).toContain("parsed 0 jobs");
    });
  }

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

    expect(result.jobs).toEqual([]);
    expect(result.status).toBe("unparseable");
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
