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

import {
  RobotsCache,
  ScrapeClient,
  parseHtml,
  type FetchOptions,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { RemotelyDeAdapter } from "../src/adapters/remotelyde";
import { RemoteInEuropeAdapter } from "../src/adapters/remoteineurope";
import { SimplyHiredAdapter } from "../src/adapters/simplyhired";
import { JobgetherAdapter } from "../src/adapters/jobgether";
import type { BaseAdapter } from "../src/adapters/base";

const FIXTURES = join(import.meta.dir, "fixtures", "boards");

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf-8");
}

/** An HTTP client that answers every request with one fixture, or throws. */
class StubClient extends ScrapeClient {
  constructor(private readonly answer: string | Error) {
    super();
  }
  override async getText(_url: string, _opts: FetchOptions = {}): Promise<string> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function contextServing(answer: string | Error): ScrapeContext {
  return { http: new StubClient(answer), log: () => {} };
}

/** Run an adapter over a fixture, with no network and no browser. */
async function scrapeAgainst(adapter: BaseAdapter, answer: string | Error) {
  return adapter.bind(contextServing(answer)).scrape({ incremental: false });
}

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
  test("reports zero found and zero errors on a page that is not its site (#37)", async () => {
    const html = fixture("remoteineurope", "redirect-target.html");
    // Every configured URL answers 301 to weworkremotely.com; this is a slice
    // of what comes back.
    expect(html).toContain('href="https://weworkremotely.com/remote-software-developer-jobs"');
    expect(html).not.toContain('href="/job/');

    const result = await scrapeAgainst(new RemoteInEuropeAdapter(), html);
    expect(result.jobs).toEqual([]);
    expect(result.errors).toEqual([]);
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
  test("the card link is relative, and is stored unchanged (#35)", () => {
    const $ = parseHtml(fixture("dice", "rendered-card.html"));
    const link = $('a[aria-label^="View Details for"]').first();
    expect(link.attr("href")).toStartWith("/job-detail/");
    expect(link.attr("href")).not.toStartWith("http");
    // The company has a stable selector here too.
    expect($('a[href^="/company-profile/"]').length).toBeGreaterThan(0);
  });
});
