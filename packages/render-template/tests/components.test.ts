import { describe, expect, test } from "bun:test";

import { buildHtmlDocument } from "../src/template";
import { DOCUMENT_BLOCKS, DOCUMENT_CLASSES } from "../src/components";
import { lintDocument } from "../src/lint";
import { STYLES } from "../src/styles";

/** Every class selector in the stylesheet, comments excluded. */
function selectorClasses(css: string): Set<string> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...code.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
}

/** Every class a snippet of HTML uses. */
function markupClasses(html: string): string[] {
  return [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));
}

describe("the component contract (#530)", () => {
  // The class list is the CSS contract: agents compose documents from these
  // names, so renaming or dropping one breaks every document that used it.
  // Change this list on purpose, never as a side effect.
  test("is exactly this list of classes", () => {
    expect([...DOCUMENT_CLASSES]).toEqual([
      "doc--compact", "doc--editorial",
      "doc-actions", "doc-badge", "doc-badge--accent", "doc-badge--bad", "doc-badge--ok", "doc-badge--warn",
      "doc-bars", "doc-button", "doc-button--accent", "doc-button--quiet",
      "doc-callout", "doc-callout--critical", "doc-callout--warning",
      "doc-card", "doc-card--accent", "doc-card--tint",
      "doc-checklist", "doc-cols", "doc-cols--three", "doc-cols--wide-end", "doc-cols--wide-start",
      "doc-compare", "doc-cons", "doc-delta", "doc-delta--down", "doc-delta--up", "doc-eyebrow", "doc-fineprint",
      "doc-hero", "doc-hero--cover", "doc-hero--solid", "doc-hero--split", "doc-hero-image", "doc-hero-text",
      "doc-keep", "doc-kv", "doc-kv--facts", "doc-kv--row", "doc-kv--stacked",
      "doc-letterhead", "doc-lines", "doc-mark", "doc-n", "doc-option", "doc-page-break", "doc-price", "doc-pros",
      "doc-quote", "doc-stat-label", "doc-stat-value", "doc-stats", "doc-steps", "doc-summary",
      "doc-timeline", "doc-total", "doc-zebra",
      "is-done", "is-key", "is-pick",
      "mermaid-figure", "num", "remote-image",
    ]);
  });

  test("every listed class has a rule in the stylesheet", () => {
    const styled = selectorClasses(STYLES);
    expect(DOCUMENT_CLASSES.filter((c) => !styled.has(c))).toEqual([]);
  });

  test("every class the stylesheet styles is listed", () => {
    const listed = new Set(DOCUMENT_CLASSES);
    expect([...selectorClasses(STYLES)].filter((c) => !listed.has(c))).toEqual([]);
  });

  describe("block snippets", () => {
    test("names are unique", () => {
      const names = DOCUMENT_BLOCKS.map((b) => b.name);
      expect(names.length, "the block catalogue is populated").toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    });

    for (const block of DOCUMENT_BLOCKS) {
      test(`${block.name} uses every class it introduces, and only listed ones`, () => {
        const used = markupClasses(block.html);
        expect(used.length).toBeGreaterThan(0);
        expect(block.classes.filter((c) => !used.includes(c))).toEqual([]);
        expect(used.filter((c) => !DOCUMENT_CLASSES.includes(c))).toEqual([]);
      });

      test(`${block.name} renders without a warning`, () => {
        const html = buildHtmlDocument({ content: block.html, contentType: "html" });
        expect(lintDocument(html)).toEqual([]);
      });
    }
  });
});
