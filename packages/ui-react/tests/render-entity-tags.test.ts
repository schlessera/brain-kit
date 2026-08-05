import { describe, test, expect } from "bun:test";

// Extracted from whatsup-modal.tsx for testability
const ENTITY_TAGS: Record<string, string> = {
  co: "entity-co",
  p: "entity-p",
  proj: "entity-proj",
  ev: "entity-ev",
  d: "entity-d",
  st: "entity-st",
  f: "entity-f",
};

function renderEntityTags(md: string): string {
  let result = md.replace(
    /<(co|p|proj|ev|d|st|f)>(.*?)<\/\1>/g,
    (_match, tag, content) => {
      const cls = ENTITY_TAGS[tag] || "";
      return `<span class="${cls}">${content}</span>`;
    }
  );
  result = result.replace(/<\/?(?:co|p|proj|ev|d|st|f)>/g, "");
  return result;
}

describe("renderEntityTags", () => {
  test("converts company tag", () => {
    expect(renderEntityTags("<co>Bluehost</co>")).toBe(
      '<span class="entity-co">Bluehost</span>'
    );
  });

  test("converts person tag", () => {
    expect(renderEntityTags("<p>Alex Frison</p>")).toBe(
      '<span class="entity-p">Alex Frison</span>'
    );
  });

  test("converts project tag", () => {
    expect(renderEntityTags("<proj>NLWeb</proj>")).toBe(
      '<span class="entity-proj">NLWeb</span>'
    );
  });

  test("converts event tag", () => {
    expect(renderEntityTags("<ev>WCEU 2026</ev>")).toBe(
      '<span class="entity-ev">WCEU 2026</span>'
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
      "- <co>Bluehost</co> — deadline <d>April 5</d>, status <st>pending</st>";
    const result = renderEntityTags(input);
    expect(result).toContain('class="entity-co"');
    expect(result).toContain('class="entity-d"');
    expect(result).toContain('class="entity-st"');
    expect(result).not.toContain("<co>");
    expect(result).not.toContain("<d>");
  });

  test("handles nested entity inside bold markdown", () => {
    const input = "**<p>Alex Frison</p> (<co>Syde</co>)**";
    const result = renderEntityTags(input);
    expect(result).toBe(
      '**<span class="entity-p">Alex Frison</span> (<span class="entity-co">Syde</span>)**'
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
    expect(result).toBe(input); // unchanged
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
    const input = "<p>Alice</p> met <p>Bob</p>";
    const result = renderEntityTags(input);
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("</p>");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  test("handles real whatsup output line", () => {
    const input =
      '- **<p>Alex Frison</p> (<co>Syde</co>)** — Follow up, deadline <d>April 10</d>';
    const result = renderEntityTags(input);
    expect(result).toContain('<span class="entity-p">Alex Frison</span>');
    expect(result).toContain('<span class="entity-co">Syde</span>');
    expect(result).toContain('<span class="entity-d">April 10</span>');
    expect(result).not.toMatch(/<(?:co|p|d|st|ev|proj|f)>/);
  });
});
