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
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Window } from "happy-dom";

import {
  RobotsCache,
  ScrapeClient,
  parseHtml,
  type BrowserSession,
  type FetchOptions,
  type PageRequest,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { BuiltInAdapter } from "../src/adapters/builtin";
import { DiceAdapter } from "../src/adapters/dice";
import { NodeskAdapter } from "../src/adapters/nodesk";
import type { BrowserJobRecord } from "../src/adapters/browser-base";
import { RemotelyDeAdapter } from "../src/adapters/remotelyde";
import { RemoteInEuropeAdapter } from "../src/adapters/remoteineurope";
import { SimplyHiredAdapter } from "../src/adapters/simplyhired";
import { JobgetherAdapter } from "../src/adapters/jobgether";
import type { BaseAdapter } from "../src/adapters/base";
import { openDatabase } from "../src/db";
import { runDedup } from "../src/dedup";
import { ingestJobs } from "../src/scrape";
import type { RawJob } from "../src/types";

const FIXTURES = join(import.meta.dir, "fixtures", "boards");

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf-8");
}

/**
 * An HTTP client that answers every request with one fixture, or throws.
 *
 * Every read path is sealed, not just the one these tests happen to call.
 * `ScrapeClient.getJson` and `get` are ordinary methods: an override of
 * `getText` alone leaves them inherited, and `get` reaches `clearToFetch`,
 * which fetches robots.txt over the network before it has even looked at the
 * URL. Nothing here calls them today. The next adapter wired into this file
 * would, and the test would go green over a real request.
 */
class StubClient extends ScrapeClient {
  constructor(private readonly answer: string | Error) {
    super();
  }

  private body(): string {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  override async getText(_url: string, _opts: FetchOptions = {}): Promise<string> {
    return this.body();
  }

  override async getJson<T = unknown>(_url: string, _opts: FetchOptions = {}): Promise<T> {
    return JSON.parse(this.body()) as T;
  }

  override async get(url: string, _opts: FetchOptions = {}): Promise<Response> {
    throw new Error(
      `StubClient.get(${url}) — these tests answer from a fixture and must never ` +
        `reach the network. Add the read path you need to StubClient instead.`
    );
  }
}

function contextServing(answer: string | Error): ScrapeContext {
  return { http: new StubClient(answer), log: () => {} };
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

/** Run an adapter over a fixture, with no network and no browser. */
async function scrapeAgainst(adapter: BaseAdapter, answer: string | Error) {
  return adapter.bind(contextServing(answer)).scrape({ incremental: false });
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
  test("stores category chrome instead of jobs, and reports no error (#35)", async () => {
    const result = await scrapeAgainst(new RemotelyDeAdapter(), fixture("remotelyde", "listing.html"));

    // The one row it finds is the /remote-jobs/teilzeit category link the
    // fallback at src/adapters/remotelyde.ts:102 matches.
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].url).toBe("https://remotely.de/remote-jobs/teilzeit");
    expect(result.jobs[0].company).toBe("Unknown");
    expect(result.jobs[0].description).toBeUndefined();
    // Nothing went wrong as far as the adapter is concerned. That is the bug
    // the epic is named after, and #37 is where it starts saying so.
    expect(result.errors).toEqual([]);
  });

  test("the JSON-LD is there; the regex at :53 will not see it (#34)", () => {
    const html = fixture("remotelyde", "listing.html");
    // What the page serves.
    expect(html).toContain('<script id="collection-page-jsonld" type="application/ld+json">');
    // What the adapter looks for.
    expect(html).not.toContain('<script type="application/ld+json">');
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
    // ListItem -> { "@id", "name" }. No @type, so mapJobPosting skips it, and
    // no hiringOrganization or description to map even if it did not.
    for (const entry of items) {
      expect(entry.item["@type"]).toBeUndefined();
      expect(entry.item.hiringOrganization).toBeUndefined();
      expect(entry.item.description).toBeUndefined();
    }
  });
});

describe("remoteineurope against what its domain now serves", () => {
  const served = () => fixture("remoteineurope", "redirect-target.html");

  test("reports zero found and zero errors on a page that is not its site (#37)", async () => {
    const html = served();
    // Every configured URL answers 301 to weworkremotely.com; this is a slice
    // of what comes back.
    expect(html).toContain('href="https://weworkremotely.com/remote-software-developer-jobs"');
    expect(html).not.toContain('href="/job/');

    const result = await scrapeAgainst(new RemoteInEuropeAdapter(), html);
    expect(result.jobs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("the parser still runs — it is pointed at a link shape that is not there", async () => {
    // Without this half the test above passes for the WRONG reason: an adapter
    // whose parser had been gutted to `return []` satisfies it just as well,
    // and it is the only executable evidence for #37's premise. Same bytes,
    // with the one thing changed that the parser looks for.
    const rewritten = served().replaceAll('href="/remote-jobs/', 'href="/job/');
    const result = await scrapeAgainst(new RemoteInEuropeAdapter(), rewritten);

    expect(result.jobs).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(result.jobs.map((job) => job.url)).toEqual([
      "https://remoteineurope.com/job/sanctuary-computer-senior-shopify-developer",
      "https://remoteineurope.com/job/samsara-staff-software-engineer",
    ]);
  });

  test("and when it runs, the titles are still the whole card (#128)", async () => {
    // The August table's "titles like 'Canonical 1 Apr Canonical Senior Design
    // Researcher'" was never fixed — it is only hidden, because the parser
    // matches nothing at all today. Repointing this adapter at a live board
    // would bring the mangling straight back, so the title extraction is part
    // of whatever #128 decides, not a separate surprise.
    const rewritten = served().replaceAll('href="/remote-jobs/', 'href="/job/');
    const result = await scrapeAgainst(new RemoteInEuropeAdapter(), rewritten);

    expect(result.jobs[0].title).toStartWith("Senior Shopify Developer");
    expect(result.jobs[0].title).toContain("Sanctuary Computer");
    expect(result.jobs[0].title).toContain("4d");
    // The company comes out of the surrounding markup, and on the second card
    // it is a location.
    expect(result.jobs[0].company).toBe("Sanctuary Computer");
    expect(result.jobs[1].company).toBe("New York City");
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

describe("jobgether against the response its category URLs give", () => {
  test("every configured URL fails, and the adapter says so", async () => {
    const result = await scrapeAgainst(
      new JobgetherAdapter(),
      new Error("HTTP 410 from https://jobgether.com/remote-jobs/all-locations/software-engineering")
    );
    expect(result.jobs).toEqual([]);
    // One per URL in src/adapters/jobgether.ts:6-12.
    expect(result.errors).toHaveLength(5);
    expect(result.errors[0]).toContain("410");
  });

  test("the 410 body names the replacement page", () => {
    expect(fixture("jobgether", "response-410.html")).toContain(
      'href="https://jobgether.com/search-offers"'
    );
  });

  test("the endpoint its robots.txt allows carries company and url (#35)", () => {
    const data = JSON.parse(fixture("jobgether", "astroapi-ai-jobs.json"));
    expect(data.jobs.length).toBeGreaterThan(0);
    for (const job of data.jobs) {
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.url).toStartWith("https://jobgether.com/offer/");
    }
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
