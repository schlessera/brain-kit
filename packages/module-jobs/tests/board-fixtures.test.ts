/**
 * What the boards actually serve, made executable.
 *
 * These are CHARACTERIZATION tests: several of them assert behaviour that is
 * WRONG, because that is what the adapters do today against the markup in
 * `fixtures/boards/`. Issue #33 measured it live; this file is what keeps the
 * measurement true after the live sites move on, and it is where the repairs
 * in #34-#37 will land as changed expectations rather than as new files.
 *
 * Every assertion that pins a defect says so, and names the issue that flips
 * it. Nothing here touches the network — the fixtures are the network.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Window } from "happy-dom";

import {
  RobotsCache,
  ScrapeClient,
  extractJsonLd,
  parseHtml,
  type BrowserSession,
  type FetchedPage,
  type FetchOptions,
  type PageRequest,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { BuiltInAdapter } from "../src/adapters/builtin";
import { DiceAdapter } from "../src/adapters/dice";
import { NodeskAdapter } from "../src/adapters/nodesk";
import type { BrowserJobRecord } from "../src/adapters/browser-base";
import { RemotelyDeAdapter } from "../src/adapters/remotelyde";
import { SimplyHiredAdapter } from "../src/adapters/simplyhired";
import { JobgetherAdapter } from "../src/adapters/jobgether";
import { RemotiveAdapter } from "../src/adapters/remotive";
import type { BaseAdapter } from "../src/adapters/base";
import { openDatabase } from "../src/db";
import { runDedup } from "../src/dedup";
import { ingestJobs } from "../src/scrape";
import { ALL_SOURCES, DISABLED_BY_DEFAULT, RETIRED_SOURCES, SOURCES, type RawJob } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures", "boards");

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf-8");
}

/**
 * What a stub answers one request with: a body, a body served from another
 * URL (a redirect the caller followed), or a throw.
 */
type StubAnswer = string | Error | FetchedPage;

/**
 * An HTTP client that answers every request from a fixture, or throws.
 *
 * Every read path is sealed, not just the one these tests happen to call.
 * `ScrapeClient.getJson` and `get` are ordinary methods: an override of
 * `getText` alone leaves them inherited, and `get` reaches `clearToFetch`,
 * which fetches robots.txt over the network before it has even looked at the
 * URL. `getJson` is no longer hypothetical — jobgether reads a JSON endpoint
 * since #35 — and `get` still is, which is exactly when a seal is cheap.
 *
 * A function answer routes by URL, which is how a board with more than one
 * page is served; `requests` is every URL asked for, in order, so a test can
 * pin the request count as well as the parse.
 */
class StubClient extends ScrapeClient {
  readonly requests: string[] = [];

  constructor(private readonly answer: StubAnswer | ((url: string) => StubAnswer)) {
    super();
  }

  private page(url: string): FetchedPage {
    this.requests.push(url);
    const answer = typeof this.answer === "function" ? this.answer(url) : this.answer;
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? { body: answer, url } : answer;
  }

  /**
   * The primitive the real client reads text through, so overriding it seals
   * `getText` as well — and lets a fixture say the response came from
   * somewhere else, which is how a board whose domain now redirects to
   * another site is asserted without the network.
   */
  override async getPage(url: string, _opts: FetchOptions = {}): Promise<FetchedPage> {
    return this.page(url);
  }

  override async getText(url: string, _opts: FetchOptions = {}): Promise<string> {
    return this.page(url).body;
  }

  override async getJson<T = unknown>(url: string, _opts: FetchOptions = {}): Promise<T> {
    return JSON.parse(this.page(url).body) as T;
  }

  override async get(url: string, _opts: FetchOptions = {}): Promise<Response> {
    throw new Error(
      `StubClient.get(${url}) — these tests answer from a fixture and must never ` +
        `reach the network. Add the read path you need to StubClient instead.`
    );
  }
}

/**
 * A context whose HTTP client answers from a fixture, and the URLs it was
 * asked for — the same shape `browserContextServing` returns, so an HTTP board
 * and a browser board are asserted the same way.
 */
function contextServing(
  answer: StubAnswer | ((url: string) => StubAnswer)
): { ctx: ScrapeContext; requests: string[] } {
  const http = new StubClient(answer);
  return { ctx: { http, log: () => {} }, requests: http.requests };
}

/**
 * Run a page function over a fixture in a real DOM.
 *
 * A browser board's extractor is written to run inside Chrome and closes over
 * nothing, so it only needs a `document` — which is why this can be a keyless
 * test rather than a Chrome launch. What happy-dom does NOT have is layout, so
 * `innerText` is effectively `textContent` here: a field an extractor recovers
 * by scanning a card's visible LINES gets different lines than Chrome would,
 * and stays unasserted. Dice's salary and employment type are read that way;
 * its company is not, since #129.
 */
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

/** Run a browser board's page function over a fixture in a real DOM. */
function extractFrom(
  adapter: { extract(): BrowserJobRecord[] },
  html: string
): BrowserJobRecord[] {
  return inFixtureDom(html, () => adapter.extract());
}

/**
 * A whole browser board run, with no Chrome and no network.
 *
 * Every page the adapter asks for is answered with the same fixture, so what
 * comes back is the adapter's own `RawJob` — the row that would be ingested —
 * rather than the page record its extractor returned. The HTTP client throws:
 * a browser board that reaches for one is a bug, not a fallback.
 */
function browserContextServing(html: string): { ctx: ScrapeContext; requests: string[] } {
  const requests: string[] = [];
  const browser: BrowserSession = {
    async load<T>(request: PageRequest<T>): Promise<T> {
      requests.push(request.url);
      return inFixtureDom(html, request.extract);
    },
    async close() {},
  };
  return {
    ctx: {
      http: new StubClient(new Error("a browser board must not reach for HTTP")),
      browser,
      log: () => {},
    },
    requests,
  };
}

/** The page function, reachable without constructing a browser context. */
function pageFunctionOf<T>(cls: new (...args: never[]) => T): { extract(): BrowserJobRecord[] } {
  return cls.prototype as unknown as { extract(): BrowserJobRecord[] };
}

/**
 * Run an adapter over a fixture, with no network and no browser.
 *
 * The result carries `requests` alongside the usual envelope, so a test can
 * assert what the adapter asked for as well as what it parsed.
 */
async function scrapeAgainst(
  adapter: BaseAdapter,
  answer: StubAnswer | ((url: string) => StubAnswer)
) {
  const { ctx, requests } = contextServing(answer);
  const result = await adapter.bind(ctx).scrape({ incremental: false });
  return { ...result, requests };
}

describe("the fixture client", () => {
  test("answers from the fixture on every read path, and refuses the raw one", async () => {
    const client = new StubClient('{"jobs":[{"title":"X"}]}');
    expect(await client.getText("https://example.test/")).toBe('{"jobs":[{"title":"X"}]}');
    expect(await client.getJson<{ jobs: Array<{ title: string }> }>("https://example.test/")).toEqual({
      jobs: [{ title: "X" }],
    });
    // `get` is what reaches robots.txt over the network before it has even
    // looked at the URL, so it is sealed shut rather than stubbed.
    await expect(client.get("https://example.test/")).rejects.toThrow("must never");
  });
});

describe("remotelyde against its captured listing", () => {
  test("parses the featured card and ignores the category chrome (#35)", async () => {
    const html = fixture("remotelyde", "listing.html");
    // The link every stored row used to be. It is still in the fixture, so a
    // parser that goes back to matching /remote-jobs/<slug> fails here.
    expect(html).toContain('href="/remote-jobs/teilzeit"');

    const result = await scrapeAgainst(new RemotelyDeAdapter(), html);

    expect(result.jobs).toHaveLength(1);
    const [job] = result.jobs;
    expect(job.url).toBe(
      "https://www.remotely.de/job/rws-trainai-audio-transcription-german-germany"
    );
    expect(job.title).toBe("Audio Transcription - German (Germany)");
    expect(job.company).toBe("RWS TrainAI");
    expect(job.location).toBe("Nur DE");
    expect(job.remote_type).toBe("fully_remote");
    // The featured layout carries a five-line teaser. A full description
    // still needs the detail page (#36).
    expect(job.description).toContain("Audio Transcriber");
    // And nothing at all came from the chrome: not one stored row is a
    // /remote-jobs/<slug> category page.
    expect(result.jobs.filter((row) => row.url?.includes("/remote-jobs/"))).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("reads the company off the ordinary row layout too (#35)", async () => {
    const result = await scrapeAgainst(
      new RemotelyDeAdapter(),
      fixture("remotelyde", "listing-row-cards.html")
    );

    // Most cards are this layout, and it puts the company in the meta line
    // rather than beside the logo: "<company> \u00b7 <location>".
    expect(result.jobs.map((job) => [job.company, job.location])).toEqual([
      ["Grafana Labs", "Spanien +4 weitere"],
      ["Do Good Ventures", "Weltweit"],
    ]);
    for (const job of result.jobs) {
      expect(job.title).toBeTruthy();
      expect(job.company).not.toBe("Unknown");
      expect(job.url).toStartWith("https://www.remotely.de/job/");
    }
    expect(result.errors).toEqual([]);
  });

  test("a card with no company is dropped, and the field is named (#35)", async () => {
    const html = fixture("remotelyde", "listing-row-cards.html").replace(
      "Do Good Ventures \u00b7 Weltweit",
      ""
    );
    const result = await scrapeAgainst(new RemotelyDeAdapter(), (url) =>
      url.endsWith("/remote-jobs") ? html : ""
    );

    expect(result.jobs.map((job) => job.company)).toEqual(["Grafana Labs"]);
    expect(result.errors).toEqual(["remotely.de page 1: 1 card(s) carried no company"]);
  });

  test("a blank company is not filled in from the location beside it (#35)", async () => {
    // The meta line is "<company> \u00b7 <location>". Emptying the company half
    // leaves " \u00b7 Weltweit", and a parser that drops empty pieces before
    // taking the first one stores "Weltweit" as the employer.
    const html = fixture("remotelyde", "listing-row-cards.html").replace(
      "Do Good Ventures \u00b7 Weltweit",
      " \u00b7 Weltweit"
    );
    const result = await scrapeAgainst(new RemotelyDeAdapter(), (url) =>
      url.endsWith("/remote-jobs") ? html : ""
    );

    expect(result.jobs.map((job) => job.company)).toEqual(["Grafana Labs"]);
    expect(result.errors).toEqual(["remotely.de page 1: 1 card(s) carried no company"]);
  });

  test("fetches www and /remote-jobs/seite/<n>, each exactly once (#35)", async () => {
    const pages: Record<string, string> = {
      "https://www.remotely.de/remote-jobs": fixture("remotelyde", "listing.html"),
      "https://www.remotely.de/remote-jobs/seite/2": fixture(
        "remotelyde",
        "listing-row-cards.html"
      ),
    };
    const result = await scrapeAgainst(new RemotelyDeAdapter(), (url) => pages[url] ?? "");

    // The apex 301s to www and ?page=<n> 308s to /seite/<n>; asking for
    // either shape is a wasted request the site has already told us about.
    expect(result.requests).toEqual([
      "https://www.remotely.de/remote-jobs",
      "https://www.remotely.de/remote-jobs/seite/2",
      "https://www.remotely.de/remote-jobs/seite/3",
    ]);
    expect(new Set(result.requests).size).toBe(result.requests.length);
    expect(result.jobs).toHaveLength(3);
  });

  test("the JSON-LD the bare-tag regex could not see is extracted now (#34)", () => {
    const html = fixture("remotelyde", "listing.html");
    // What the page serves: an id BEFORE the type attribute. The adapter no
    // longer reads JSON-LD at all -- #35 moved it to the cards -- but the
    // attribute intolerance this pins is what #34 fixed in the shared
    // extractor, and the boards that do have a JobPosting still hit it.
    expect(html).toContain('<script id="collection-page-jsonld" type="application/ld+json">');
    // What the pattern this replaces required, and the reason this page read
    // as having no structured data at all.
    expect(html).not.toContain('<script type="application/ld+json">');
    // The shared extractor reads it. What is IN it is the next test.
    expect(extractJsonLd(html).documents).toHaveLength(1);
  });

  test("even parsed, the listing JSON-LD carries no JobPosting (#36)", () => {
    const html = fixture("remotelyde", "listing.html");
    const json = html.slice(
      html.indexOf(">", html.indexOf("collection-page-jsonld")) + 1,
      html.indexOf("</script>")
    );
    const data = JSON.parse(json);
    expect(data["@type"]).toBe("CollectionPage");
    const items = data.mainEntity.itemListElement;
    expect(items.length).toBeGreaterThan(0);
    // ListItem -> { "@id", "name" }. No @type, and no hiringOrganization or
    // description, so no JobPosting mapper can get a company or a description
    // out of this page however tolerant it is. That is why #35 reads the
    // cards instead, and why a real description still needs #36.
    for (const entry of items) {
      expect(entry.item["@type"]).toBeUndefined();
      expect(entry.item.hiringOrganization).toBeUndefined();
      expect(entry.item.description).toBeUndefined();
    }
  });
});

describe("remoteineurope is retired, and what its domain serves is why (#128)", () => {
  const served = () => fixture("remoteineurope", "redirect-target.html");

  test("the domain serves another board's listing, which a repaired parser would only duplicate", () => {
    // This was the test pinning `0 found, 0 errors` (and, after #37, one
    // `parsed 0 jobs` error per page). The adapter is gone; the fixture stays
    // as the record of why. Every configured URL answered 301 to
    // weworkremotely.com, and this is a slice of what came back: We Work
    // Remotely's own markup, whose postings the `weworkremotely` board already
    // scrapes.
    const html = served();
    expect(html).toContain('href="https://weworkremotely.com/remote-software-developer-jobs"');
    expect(html).toContain('href="/remote-jobs/');
    expect(html).not.toContain('href="/job/');

    expect(ALL_SOURCES as readonly string[]).not.toContain("remoteineurope");
    expect(ALL_SOURCES).toContain("weworkremotely");
    expect(RETIRED_SOURCES.remoteineurope).toContain("weworkremotely");
  });
});

describe("simplyhired against its captured card", () => {
  test("title and company parse; there is no description to parse (#36)", async () => {
    const result = await scrapeAgainst(
      new SimplyHiredAdapter(["backend engineer"]),
      fixture("simplyhired", "listing-card.html")
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe("FDE Backend Platform Engineer - USA");
    expect(result.jobs[0].company).toBe("Inviso");
    expect(result.jobs[0].description).toBeUndefined();
    expect(fixture("simplyhired", "listing-card.html")).not.toContain("Snippet");
  });
});

describe("jobgether against the JSON endpoint its robots.txt allows", () => {
  test("the 410 body names the replacement page", () => {
    expect(fixture("jobgether", "response-410.html")).toContain(
      'href="https://jobgether.com/search-offers"'
    );
  });

  test("the alias #33 captured and /api/v1/jobs serve the same record (#35)", () => {
    // The site's own docs retire /astroapi/ai/jobs on 2026-09-28 in favour of
    // /api/v1/jobs. Same shape, so the capture #33 took still describes what
    // the adapter now fetches.
    const alias = JSON.parse(fixture("jobgether", "astroapi-ai-jobs.json"));
    const current = JSON.parse(fixture("jobgether", "api-v1-jobs.json"));
    expect(Object.keys(alias.jobs[0]).sort()).toEqual(Object.keys(current.jobs[0]).sort());
  });

  test("fetches /api/v1/jobs exactly once, with no query string (#35)", async () => {
    const result = await scrapeAgainst(
      new JobgetherAdapter(),
      fixture("jobgether", "api-v1-jobs.json")
    );

    // robots.txt disallows /*?* on this path, and ?page=/?limit= is the only
    // way the endpoint pages. One request, and it carries no query string.
    expect(result.requests).toEqual(["https://jobgether.com/api/v1/jobs"]);
    expect(result.requests[0]).not.toInclude("?");
  });

  test("every row carries a title, a real company and its salary (#35)", async () => {
    const result = await scrapeAgainst(
      new JobgetherAdapter(),
      fixture("jobgether", "api-v1-jobs.json")
    );

    expect(result.errors).toEqual([]);
    expect(result.jobs).toHaveLength(3);
    for (const job of result.jobs) {
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.company).not.toBe("Unknown");
      expect(job.url).toStartWith("https://jobgether.com/offer/");
      // postedAt is already ISO on this endpoint.
      expect(job.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(result.jobs[0].company).toBe("Grafana Labs");
    expect(result.jobs[0].salary_min).toBe(186240);
    expect(result.jobs[0].salary_currency).toBe("EUR");
    expect(result.jobs[0].job_type).toBe("full_time");
    // The wire carries "Samsara " with a trailing space.
    expect(result.jobs[2].company).toBe("Samsara");
  });

  test("an offer with no company is dropped, and the field is named (#35)", async () => {
    const data = JSON.parse(fixture("jobgether", "api-v1-jobs.json"));
    delete data.jobs[0].company;
    const result = await scrapeAgainst(new JobgetherAdapter(), JSON.stringify(data));

    expect(result.jobs).toHaveLength(2);
    expect(result.errors).toEqual(["Jobgether: 1 offer(s) carried no company"]);
  });
});

describe("remotive's robots.txt", () => {
  test("disallows the only path the adapter fetches", async () => {
    const robots = new RobotsCache({
      fetcher: async () => ({ status: 200, body: fixture("remotive", "robots.txt") }),
    });
    const rules = await robots.forUrl("https://remotive.com/api/remote-jobs");
    expect(rules.loaded).toBe(true);
    expect(
      rules.isAllowed(
        "https://remotive.com/api/remote-jobs?category=software-dev&limit=100",
        "brain-scrape"
      )
    ).toBe(false);
  });

  test("so the adapter fails every request it makes, before any reaches the network (#130)", async () => {
    // The real adapter, through a real ScrapeClient, with the committed
    // robots.txt served in place of the live one. Every category request is
    // refused by the politeness layer; nothing is fetched.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("the network must never be reached from this test");
    }) as unknown as typeof fetch);
    try {
      const http = new ScrapeClient({
        robots: new RobotsCache({
          fetcher: async () => ({ status: 200, body: fixture("remotive", "robots.txt") }),
        }),
      });
      const result = await new RemotiveAdapter().bind({ http, log: () => {} }).scrape({ incremental: false });

      expect(result.jobs).toEqual([]);
      expect(result.status).toBe("not_run");
      expect(result.errors).toHaveLength(5);
      for (const error of result.errors) expect(error).toContain("robots.txt disallows");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("and a board that fails by construction is not enabled by default (#130)", () => {
    // The ruling was to demote it, not retire it: the adapter stays for anyone
    // the site gives permission to, and the reason says so.
    expect(SOURCES as readonly string[]).not.toContain("remotive");
    expect(ALL_SOURCES).toContain("remotive");
    expect(DISABLED_BY_DEFAULT).toHaveProperty("remotive");
    const reason = (DISABLED_BY_DEFAULT as Record<string, string>).remotive;
    expect(reason).toContain("robots.txt disallows /api/*");
    expect(reason).toContain("permission");
  });
});

// The three browser boards run their extractor inside Chrome, so what a
// keyless test can pin is the SHAPE of the rendered markup — which is exactly
// where each of the three diagnoses lives.

describe("builtin's listing JSON-LD", () => {
  test("carries a description for every job the adapter throws away (#34, #36)", () => {
    const html = fixture("builtin", "listing-jsonld.html");
    // Bare tag here, unlike remotely.de — the attribute intolerance is a real
    // defect but it is not what costs builtin its descriptions. Reading the
    // DOM instead of the structured data is.
    expect(html).toContain('<script type="application/ld+json">');
    const data = JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>")));
    const list = data["@graph"].find((node: { "@type": string }) => node["@type"] === "ItemList");
    expect(list.itemListElement.length).toBeGreaterThan(0);
    for (const entry of list.itemListElement) {
      expect(entry.name).toBeTruthy();
      expect(entry.url).toStartWith("https://builtin.com/job/");
      expect(entry.description.length).toBeGreaterThan(50);
      // Still no company: #35 cannot get that from here.
      expect(entry.hiringOrganization).toBeUndefined();
    }
  });
});

describe("builtin's rendered card", () => {
  test("the extractor returns no company at all (#35)", () => {
    const records = extractFrom(
      pageFunctionOf(BuiltInAdapter),
      fixture("builtin", "rendered-card.html")
    );
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Staff Software Engineer, Assets");
    // Which BrowserAdapter.toRawJob turns into the literal "Unknown" — 35 of
    // 35 rows in the live run, 19 of 19 cards on the captured page.
    expect(records[0].company).toBe("");
  });

  test("the anchor's own class is why closest() never reaches the card (#35)", () => {
    const $ = parseHtml(fixture("builtin", "rendered-card.html"));
    const link = $('a[href*="/job/"]').first();
    expect(link.length).toBe(1);
    // src/adapters/builtin.ts:44 asks for closest('[class*="job"], [class*="card"], …'),
    // and Element.closest() starts at the element itself.
    expect(link.attr("class")).toContain("card");
    // Meanwhile the company is sitting behind a stable selector, contrary to
    // the comment at src/adapters/builtin.ts:26.
    expect($('a[data-id="company-title"]').text().trim()).toBe("Webflow");
  });
});

describe("nodesk's rendered card", () => {
  test("the extractor returns no company at all (#35)", () => {
    const records = extractFrom(
      pageFunctionOf(NodeskAdapter),
      fixture("nodesk", "rendered-card.html")
    );
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Customer Support Representative");
    expect(records[0].href).toBe(
      "https://nodesk.co/remote-jobs/co2lift-customer-support-representative/"
    );
    // The company is CO2Lift, and it is in the markup. 39 of the 103 cards on
    // the captured page come back like this.
    expect(records[0].company).toBe("");
  });

  test("the card has no company LINK, only a company heading (#35)", () => {
    const html = fixture("nodesk", "rendered-card.html");
    const $ = parseHtml(html);
    const $card = $("li.ais-Hits-item");
    expect($card.length).toBe(1);
    // What src/adapters/nodesk.ts:66 looks for. Nothing in the card, and
    // nothing in the promoted block beside it either, so the container walk
    // at :59 finds no company however far it climbs and the row is stored as
    // "Unknown" — 39 of the 103 cards on the captured page.
    expect($('a[href*="/remote-companies/"]').length).toBe(0);
    // Where the company actually is.
    expect($card.find("h3").first().text().trim()).toBe("CO2Lift");
    // The promoted block is in the fixture because it is what the walk climbs
    // THROUGH: on a page state that rotates in a promoted card carrying a
    // company link, that company is what gets stored on its neighbours.
    expect(html).toContain("Promoted");
  });
});

describe("dice's rendered card", () => {
  const CARD_PATH = "/job-detail/c267e627-504f-412f-b8e8-cc8a387b525d";
  const CARD_URL = `https://www.dice.com${CARD_PATH}`;

  test("the page serves a relative link, and a selector for the company (#129)", () => {
    const $ = parseHtml(fixture("dice", "rendered-card.html"));
    const link = $('a[aria-label^="View Details for"]').first();
    // What the board sends is what it always sent. Anything absolute below can
    // therefore only have come from the adapter.
    expect(link.attr("href")).toBe(CARD_PATH);
    expect(link.attr("href")).not.toStartWith("http");
    // The company the extractor used to guess at by scanning text lines.
    expect($('p[data-testid="job-card-company-name"]').text().trim()).toBe("FishEye Software");
    expect($('a[href^="/company-profile/"]').length).toBeGreaterThan(0);
  });

  test("the extractor resolves the link against the board's origin (#129)", () => {
    const records = extractFrom(
      pageFunctionOf(DiceAdapter),
      fixture("dice", "rendered-card.html")
    );
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Radar Software Engineer");
    expect(records[0].href).toBe(CARD_URL);
    // The identity is deliberately still the path, not the resolved URL and
    // not the card's data-job-guid: see BrowserJobRecord.id.
    expect(records[0].id).toBe(CARD_PATH);
    // Assertable at last, because the company comes off a selector rather than
    // off innerText lines happy-dom cannot reproduce.
    expect(records[0].company).toBe("FishEye Software");
  });

  test("a stored row carries an absolute url and source_url (#129)", async () => {
    const { ctx, requests } = browserContextServing(fixture("dice", "rendered-card.html"));

    const result = await new DiceAdapter().bind(ctx).scrape({
      incremental: false,
      queries: ["software engineer"],
    });

    expect(requests).toEqual([
      "https://www.dice.com/jobs?q=software%20engineer&filters.isRemote=true",
    ]);
    expect(result.errors).toEqual([]);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    // The two fields every consumer treats as a link. All 102 rows of the #33
    // run carried "/job-detail/<guid>" in both.
    expect(job.url).toBe(CARD_URL);
    expect(job.source_url).toBe(CARD_URL);
    expect(job.company).toBe("FishEye Software");
    // Half the upsert key in src/scrape.ts. UNCHANGED by this repair, so the
    // next scrape updates the rows already stored instead of orphaning them.
    expect(job.source_id).toBe(CARD_PATH);
  });

  /** The row the pre-repair adapter stored, 102 times, in the #33 run. */
  function rowAsStoredBefore(overrides: Partial<RawJob> = {}): RawJob {
    return {
      source: "dice",
      source_id: CARD_PATH,
      title: "Radar Software Engineer",
      company: "FishEye Software",
      url: CARD_PATH,
      source_url: CARD_PATH,
      location: "Remote",
      remote_type: "fully_remote",
      job_type: "full_time",
      ...overrides,
    };
  }

  async function repairedRow(): Promise<RawJob> {
    const { ctx } = browserContextServing(fixture("dice", "rendered-card.html"));
    const result = await new DiceAdapter().bind(ctx).scrape({
      incremental: false,
      queries: ["software engineer"],
    });
    return result.jobs[0];
  }

  test("re-scraping updates the row already stored — it does not add a second (#129)", async () => {
    const db = openDatabase(":memory:");
    try {
      ingestJobs(db, [rowAsStoredBefore({ company: "Unknown" })]);
      const stats = ingestJobs(db, [await repairedRow()]);

      // The point of keeping the key: one row, updated in place.
      expect(stats).toEqual({ new: 0, updated: 1 });
      const rows = db.query("SELECT url, source_url, company FROM jobs WHERE source = 'dice'").all();
      expect(rows).toHaveLength(1);
      // CHARACTERIZATION, not an endorsement: `ON CONFLICT ... DO UPDATE SET`
      // in src/scrape.ts refreshes `url` and nothing else that this repair
      // touches, so a row stored before it keeps its relative `source_url` and
      // its "Unknown" company. Filed as #159; both are cosmetic next to `url`,
      // which is what every consumer follows (`job.url || job.source_url`).
      expect(rows[0]).toEqual({
        url: CARD_URL,
        source_url: CARD_PATH,
        company: "Unknown",
      });
    } finally {
      db.close();
    }
  });

  test("re-keying the row would have hidden the repair behind the defect (#129)", async () => {
    const db = openDatabase(":memory:");
    try {
      ingestJobs(db, [rowAsStoredBefore()]);
      // The row was first seen in the #33 run, so it is the older of the two.
      db.query("UPDATE jobs SET first_seen_at = ? WHERE source_id = ?").run(
        "2026-09-22T16:18:00.000Z",
        CARD_PATH
      );
      // What choosing the card's data-job-guid as `source_id` would have done.
      const rekeyed = await repairedRow();
      rekeyed.source_id = "c267e627-504f-412f-b8e8-cc8a387b525d";
      expect(ingestJobs(db, [rekeyed])).toEqual({ new: 1, updated: 0 });

      expect(runDedup(db)).toEqual({ checked: 2, duplicates_found: 1 });

      // computeFingerprint keys a row with a real company on company+title,
      // not on identity — so the repaired row collides with the one it was
      // meant to replace, and `runDedup` keeps the OLDER, broken row.
      const rows = db
        .query(
          "SELECT source_id, url, is_duplicate FROM jobs WHERE source = 'dice' ORDER BY first_seen_at ASC"
        )
        .all();
      expect(rows).toEqual([
        { source_id: CARD_PATH, url: CARD_PATH, is_duplicate: 0 },
        { source_id: "c267e627-504f-412f-b8e8-cc8a387b525d", url: CARD_URL, is_duplicate: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});
