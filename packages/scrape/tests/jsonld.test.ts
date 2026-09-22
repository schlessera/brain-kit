/**
 * Seeing the tag at all, and then finding the nodes inside it.
 *
 * The script openers below are not invented: each one is the literal opener a
 * real board served on 2026-09-22, captured in
 * `packages/module-jobs/tests/fixtures/jsonld/`. What is short here is the
 * BODY, because these tests are about the wrapper and the walk rather than
 * about job vocabulary — that half is proved against the whole captured
 * documents in `packages/module-jobs/tests/jsonld-mapper.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  extractJsonLd,
  hasJsonLdType,
  itemListEntries,
  jsonLdByType,
  jsonLdNodes,
} from "../src/parse/jsonld.js";

/**
 * The pattern this replaces, verbatim from
 * `module-jobs/src/adapters/remotelyde.ts:53` before it was deleted. Kept so
 * the tolerance claim is measured against the thing that was intolerant,
 * rather than asserted.
 */
const BARE_TAG_ONLY = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function bareTagMatches(html: string): number {
  return html.match(BARE_TAG_ONLY)?.length ?? 0;
}

const POSTING = '{"@context":"https://schema.org","@type":"JobPosting","title":"Radar Software Engineer"}';

/** One opener per real board, plus the spellings HTML allows for the same thing. */
const OPENERS: Array<[label: string, opener: string, bareTagSees: boolean]> = [
  ["bare, as the old pattern required", '<script type="application/ld+json">', true],
  ["remotely.de: id first", '<script id="job-posting-jsonld" type="application/ld+json">', false],
  ["dice: test hooks after", '<script type="application/ld+json" data-testid="jobDetailStructuredData" id="jobDetailStructuredData">', false],
  ["simplyhired: framework hook after", '<script type="application/ld+json" data-next-head="">', false],
  ["nodesk: unquoted value", "<script type=application/ld+json>", false],
  ["single quotes", "<script type='application/ld+json'>", false],
  ["whitespace around the equals", '<script type = "application/ld+json">', false],
  ["a charset parameter", '<script type="application/ld+json; charset=utf-8">', false],
  ["upper case", '<SCRIPT TYPE="APPLICATION/LD+JSON">', false],
];

describe("extractJsonLd", () => {
  for (const [label, opener, bareTagSees] of OPENERS) {
    test(`extracts a script tag written ${label}`, () => {
      const html = `<html><head>${opener}${POSTING}</script></head><body>x</body></html>`;

      const { documents, errors } = extractJsonLd(html);
      expect(errors).toEqual([]);
      expect(documents).toHaveLength(1);
      expect((documents[0] as Record<string, unknown>).title).toBe("Radar Software Engineer");

      // And the same input against the pattern this replaces.
      expect(bareTagMatches(html) > 0).toBe(bareTagSees);
    });
  }

  test("does not mistake data-type for the element's type", () => {
    const html = `<script data-type="application/ld+json" type="text/plain">${POSTING}</script>`;
    expect(extractJsonLd(html).documents).toEqual([]);
  });

  test("ignores scripts that are not JSON-LD", () => {
    const html = `
      <script>window.__DATA__ = {"@type":"JobPosting"};</script>
      <script type="application/json">{"@type":"JobPosting"}</script>
      <script type="application/ld+json">${POSTING}</script>`;
    expect(extractJsonLd(html).documents).toHaveLength(1);
  });

  test("an empty placeholder tag is not an error", () => {
    const { documents, errors } = extractJsonLd('<script type="application/ld+json">\n  \n</script>');
    expect(documents).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("malformed JSON yields no document and one error, and does not throw", () => {
    const html = '<script type="application/ld+json">{"@type":"JobPosting", "title":}</script>';

    const { documents, errors } = extractJsonLd(html);
    expect(documents).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("JSON-LD script 1");
  });

  test("one malformed tag costs its own rows and nothing else", () => {
    const html = `
      <script type="application/ld+json">{ truncated</script>
      <script id="second" type="application/ld+json">${POSTING}</script>`;

    const { documents, errors } = extractJsonLd(html);
    expect(documents).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("JSON-LD script 1");
  });
});

describe("jsonLdNodes", () => {
  const posting = { "@type": "JobPosting", title: "Backend Engineer" };

  test("finds the node in each of the four shapes a page serves it in", () => {
    const bare = posting;
    const array = [{ "@type": "BreadcrumbList" }, posting];
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "CollectionPage" }, posting] };
    const nested = {
      "@type": "CollectionPage",
      mainEntity: { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: posting }] },
    };

    for (const document of [bare, array, graph, nested]) {
      expect(jsonLdByType(document, "JobPosting")).toEqual([posting]);
    }
  });

  test("walks a list of documents, as one page's several script tags give it", () => {
    expect(jsonLdByType([{ "@type": "BreadcrumbList" }, { "@graph": [posting] }], "JobPosting")).toHaveLength(1);
  });

  test("does not descend into @context, which can be an object of terms", () => {
    const document = { "@context": { JobPosting: "https://schema.org/JobPosting" }, "@type": "WebPage" };
    expect(jsonLdNodes(document)).toHaveLength(1);
  });

  test("matches a @type that is a list, case-insensitively", () => {
    expect(hasJsonLdType({ "@type": ["Thing", "JobPosting"] }, "jobposting")).toBe(true);
    expect(hasJsonLdType({ "@type": "ItemList" }, "JobPosting")).toBe(false);
  });

  test("stops rather than recursing forever on a deeply nested document", () => {
    let document: Record<string, unknown> = { "@type": "JobPosting" };
    for (let depth = 0; depth < 50; depth++) document = { child: document };
    expect(jsonLdByType(document, "JobPosting")).toEqual([]);
  });
});

describe("itemListEntries", () => {
  test("reads both of the forms an ItemList is written in", () => {
    // Built In writes the payload on the ListItem itself.
    const onTheListItem = {
      "@type": "ItemList",
      itemListElement: [{ "@type": "ListItem", position: 1, name: "Solutions Architect", url: "https://example.test/a" }],
    };
    // remotely.de wraps it in `item`.
    const inItem = {
      "@type": "ItemList",
      itemListElement: [{ "@type": "ListItem", position: 1, item: { "@id": "https://example.test/b", name: "Kundenbetreuer" } }],
    };

    expect(itemListEntries(onTheListItem)[0].name).toBe("Solutions Architect");
    expect(itemListEntries(inItem)[0].name).toBe("Kundenbetreuer");
  });

  test("drops an item that is a bare URL string, which carries nothing to map", () => {
    const breadcrumbs = {
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", name: "Remote jobs", item: "https://example.test/remote-jobs" }],
    };
    expect(itemListEntries(breadcrumbs)).toEqual([]);
  });

  test("a list with no itemListElement is empty, not an exception", () => {
    expect(itemListEntries({ "@type": "ItemList" })).toEqual([]);
  });
});
