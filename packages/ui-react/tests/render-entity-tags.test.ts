import { describe, test, expect } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderEntityTags as markEntityTags, renderEntitiesInText } from "../src/components/chat/brain-markdown-entities.js";

// Observe the production marker conversion and its actual span renderer.
function renderEntityTags(md: string): string {
  return renderToStaticMarkup(createElement("span", null, renderEntitiesInText(markEntityTags(md)))).slice(6, -7);
}

describe("renderEntityTags", () => {
  test("converts company tag", () => {
    expect(renderEntityTags("<co>Ithaca Fleet</co>")).toBe(
      '<span class="entity-co">Ithaca Fleet</span>'
    );
  });

  test("converts person tag", () => {
    expect(renderEntityTags("<p>Odysseus</p>")).toBe(
      '<span class="entity-p">Odysseus</span>'
    );
  });

  test("converts project tag", () => {
    expect(renderEntityTags("<proj>Return to Ithaca</proj>")).toBe(
      '<span class="entity-proj">Return to Ithaca</span>'
    );
  });

  test("converts event tag", () => {
    expect(renderEntityTags("<ev>Fleet council</ev>")).toBe(
      '<span class="entity-ev">Fleet council</span>'
    );
  });

  test("converts date tag", () => {
    expect(renderEntityTags("<d>April 5</d>")).toBe(
      '<span class="entity-d">April 5</span>'
    );
  });

  test("converts status tag", () => {
    expect(renderEntityTags("<st>accepted</st>")).toBe(
      '<span class="entity-st">accepted</span>'
    );
  });

  test("converts file tag", () => {
    expect(renderEntityTags("<f>me/identity.md</f>")).toBe(
      '<span class="entity-f">me/identity.md</span>'
    );
  });

  test("handles multiple tags in one line", () => {
    const input =
      "- <co>Ithaca Fleet</co> — deadline <d>April 5</d>, status <st>pending</st>";
    const result = renderEntityTags(input);
    expect(result).toContain('class="entity-co"');
    expect(result).toContain('class="entity-d"');
    expect(result).toContain('class="entity-st"');
    expect(result).not.toContain("<co>");
    expect(result).not.toContain("<d>");
  });

  test("handles nested entity inside bold markdown", () => {
    const input = "**<p>Odysseus</p> (<co>Ithaca Fleet</co>)**";
    const result = renderEntityTags(input);
    expect(result).toBe(
      '**<span class="entity-p">Odysseus</span> (<span class="entity-co">Ithaca Fleet</span>)**'
    );
  });

  test("strips unmatched entity tags", () => {
    // A <p> that isn't closed with </p> should be stripped
    const input = "Some <p>text without close";
    const result = renderEntityTags(input);
    expect(result).toBe("Some text without close");
    expect(result).not.toContain("<p>");
  });

  test("strips orphan closing tags", () => {
    const input = "text</co> more text";
    const result = renderEntityTags(input);
    expect(result).toBe("text more text");
  });

  test("preserves non-entity HTML tags", () => {
    const input = '<a href="#">link</a> and <strong>bold</strong>';
    const result = renderEntityTags(input);
    expect(markEntityTags(input)).toBe(input); // unchanged
  });

  test("handles empty entity tags", () => {
    const result = renderEntityTags("<co></co>");
    expect(result).toBe('<span class="entity-co"></span>');
  });

  test("handles text with no entity tags", () => {
    const input = "Just plain markdown with **bold** and `code`";
    expect(renderEntityTags(input)).toBe(input);
  });

  test("does not confuse <p> entity with HTML <p> paragraph", () => {
    // After conversion, no raw <p> tags should remain
    const input = "<p>Athena</p> met <p>Telemachus</p>";
    const result = renderEntityTags(input);
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("</p>");
    expect(result).toContain("Athena");
    expect(result).toContain("Telemachus");
  });

  test("handles real whatsup output line", () => {
    const input =
      '- **<p>Odysseus</p> (<co>Ithaca Fleet</co>)** — Follow up, deadline <d>April 10</d>';
    const result = renderEntityTags(input);
    expect(result).toContain('<span class="entity-p">Odysseus</span>');
    expect(result).toContain('<span class="entity-co">Ithaca Fleet</span>');
    expect(result).toContain('<span class="entity-d">April 10</span>');
    expect(result).not.toMatch(/<(?:co|p|d|st|ev|proj|f)>/);
  });
});
