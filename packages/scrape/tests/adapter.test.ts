/**
 * The seam itself: selector-driven extraction, and the runner's promise that
 * `needsBrowser` is the only thing deciding how an adapter is served.
 */
import { describe, expect, test } from "bun:test";

import { runAdapters } from "../src/adapter/runner.js";
import { extractCards, type SiteSelectors } from "../src/adapter/selectors.js";
import { ok, partial, type SiteAdapter } from "../src/adapter/types.js";
import { ScrapeClient } from "../src/fetch/http.js";
import { parseHtml } from "../src/parse/html.js";
import { parseRssItems } from "../src/parse/feed.js";

const LISTING = `
<html><body>
  <article class="card">
    <a href="/job/1">Senior Platform Engineer</a>
    <span class="company">Acme GmbH</span>
    <span class="loc">Remote</span>
  </article>
  <article class="card">
    <a href="/job/2">Backend Engineer</a>
    <span class="company">Beta AG</span>
  </article>
  <article class="card">
    <span class="company">No Link Here</span>
  </article>
</body></html>`;

const SELECTORS: SiteSelectors = {
  card: "article.card",
  fields: {
    title: { selector: "a" },
    url: { selector: "a", attr: "href", absolute: true },
    company: { selector: "span.company" },
    location: { selector: "span.loc" },
  },
  required: ["title", "url"],
};

describe("extractCards", () => {
  test("reads each card, absolutizes hrefs, and skips optional fields", () => {
    const records = extractCards(
      parseHtml(LISTING),
      SELECTORS,
      "https://jobs.example.com/list"
    );

    expect(records.length).toBe(2);
    expect(records[0]).toEqual({
      title: "Senior Platform Engineer",
      url: "https://jobs.example.com/job/1",
      company: "Acme GmbH",
      location: "Remote",
    });
    // The second card has no .loc — an absent optional field is simply absent.
    expect(records[1].location).toBeUndefined();
    expect(records[1].company).toBe("Beta AG");
  });

  test("drops a card missing a required field rather than half-filling it", () => {
    // The third card has a company but no link. A half-parsed record
    // downstream is worse than a missing one, because it looks like data.
    const records = extractCards(parseHtml(LISTING), SELECTORS, "https://jobs.example.com/list");
    expect(records.some((r) => r.company === "No Link Here")).toBe(false);
  });

  test("fallbacks cover a site that uses two layouts", () => {
    const html = `<div class="row"><h3 class="new-title">Modern</h3></div>
                  <div class="row"><span class="old-title">Legacy</span></div>`;
    const records = extractCards(
      parseHtml(html),
      {
        card: "div.row",
        fields: {
          title: {
            selector: "h3.new-title",
            fallbacks: [{ selector: "span.old-title" }],
          },
        },
        required: ["title"],
      },
      "https://example.com/"
    );
    expect(records.map((r) => r.title)).toEqual(["Modern", "Legacy"]);
  });
});

describe("parseRssItems", () => {
  test("flattens namespaced tags, unwraps CDATA, and reads url attributes", () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[Hello & goodbye]]></title>
        <dc:creator>Alex Example</dc:creator>
        <media:content url="https://example.com/img.png"/>
      </item>
    </channel></rss>`;
    const [item] = parseRssItems(xml);

    expect(item.title).toBe("Hello & goodbye");
    expect(item.dc_creator).toBe("Alex Example");
    expect(item.media_content_url).toBe("https://example.com/img.png");
  });
});

/** An adapter that records what context it was handed. */
function probe(id: string, needsBrowser: boolean, seen: string[]): SiteAdapter<string> {
  return {
    id,
    name: id,
    needsBrowser,
    needsProxy: false,
    async scrape(ctx) {
      seen.push(`${id}:${ctx.browser ? "browser" : "http"}`);
      return ok([`${id}-item`]);
    },
  };
}

describe("runAdapters", () => {
  test("never launches a browser when no adapter asks for one", async () => {
    const seen: string[] = [];
    const outcomes = await runAdapters({
      adapters: [probe("a", false, seen), probe("b", false, seen)],
      client: new ScrapeClient({ respectRobots: false }),
      // If this were consulted, creating a session would be attempted.
      browser: { executablePath: "/definitely/not/chrome" },
    });

    expect(seen).toEqual(["a:http", "b:http"]);
    expect(outcomes.map((o) => o.items).flat()).toEqual(["a-item", "b-item"]);
  });

  test("a browser adapter reports rather than crashes when none is available", async () => {
    const seen: string[] = [];
    const outcomes = await runAdapters({
      adapters: [probe("needs-chrome", true, seen), probe("http-only", false, seen)],
      client: new ScrapeClient({ respectRobots: false }),
      browser: false,
    });

    // The HTTP adapter still ran — one site's missing prerequisite is not the
    // run's failure.
    expect(seen).toEqual(["http-only:http"]);
    expect(outcomes[0].errors[0]).toContain("needs a browser");
    expect(outcomes[1].items).toEqual(["http-only-item"]);
  });

  test("an adapter that throws is isolated to its own outcome", async () => {
    const exploding: SiteAdapter<string> = {
      id: "boom",
      name: "boom",
      needsBrowser: false,
      needsProxy: false,
      async scrape() {
        throw new Error("site went away");
      },
    };
    const seen: string[] = [];
    const outcomes = await runAdapters({
      adapters: [exploding, probe("fine", false, seen)],
      client: new ScrapeClient({ respectRobots: false }),
    });

    expect(outcomes[0].errors).toEqual(["site went away"]);
    expect(outcomes[1].items).toEqual(["fine-item"]);
  });

  test("needsProxy is honoured the same way as needsBrowser", async () => {
    const outcomes = await runAdapters({
      adapters: [
        {
          id: "proxied",
          name: "proxied",
          needsBrowser: false,
          needsProxy: true,
          async scrape() {
            return ok(["should not run"]);
          },
        },
      ],
      client: new ScrapeClient({ respectRobots: false }),
    });
    expect(outcomes[0].items).toEqual([]);
    expect(outcomes[0].errors[0]).toContain("needs a proxy");
  });

  test("partial() carries what was collected alongside the error", () => {
    const result = partial(["one"], new Error("stopped halfway"), "cursor-9");
    expect(result.items).toEqual(["one"]);
    expect(result.errors).toEqual(["stopped halfway"]);
    expect(result.cursor).toBe("cursor-9");
  });
});
