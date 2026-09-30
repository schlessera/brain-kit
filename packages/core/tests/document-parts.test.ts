import { describe, expect, test } from "bun:test";

import { parseFrontmatter } from "../src/lib/frontmatter-parse";

import { frontmatterLength, readDocumentPart, SectionNotFoundError } from "../src/lib/document-parts";

const hint = 'section: "<heading>"';

const DOC = `---
title: Sample
---

Intro paragraph.

## Alpha

Alpha body.

### Alpha one

Alpha one body.

\`\`\`md
## Not a heading
\`\`\`

## Beta

Beta body.
`;

describe("readDocumentPart", () => {
  test("with neither option returns the text unchanged", () => {
    expect(readDocumentPart(DOC, { sectionHint: hint })).toBe(DOC);
  });

  test("a section runs to the next heading of the same or higher level", () => {
    const out = readDocumentPart(DOC, { section: "Alpha", sectionHint: hint });
    expect(out.startsWith("## Alpha\n")).toBe(true);
    expect(out).toContain("### Alpha one");
    expect(out).toContain("## Not a heading");
    expect(out).not.toContain("Beta body.");
    expect(out).not.toContain("title: Sample");
  });

  test("a subsection stops at its parent's next sibling", () => {
    const out = readDocumentPart(DOC, { section: "alpha ONE", sectionHint: hint });
    expect(out.startsWith("### Alpha one\n")).toBe(true);
    expect(out).not.toContain("## Beta");
  });

  test("a heading inside a code fence is not a section", () => {
    expect(() => readDocumentPart(DOC, { section: "Not a heading", sectionHint: hint })).toThrow(
      SectionNotFoundError
    );
  });

  test("an unknown section names every heading", () => {
    expect(() => readDocumentPart(DOC, { section: "Gamma", sectionHint: hint })).toThrow(
      'available headings: "Alpha", "Alpha one", "Beta"'
    );
  });

  test("over the limit, returns the frontmatter and an outline with token counts", () => {
    const out = readDocumentPart(DOC, { maxTokens: 10, sectionHint: hint });
    expect(out.startsWith("---\ntitle: Sample\n---\n")).toBe(true);
    expect(out).toContain('read one section with section: "<heading>"');
    // ~4 characters per token over each section's own lines: Alpha's 82
    // characters include its subsection's 59, Beta is 20.
    expect(out).toContain("- ## Alpha (~21 tokens)\n  - ### Alpha one (~15 tokens)\n- ## Beta (~5 tokens)\n");
    expect(out).not.toContain("body.");
  });

  test("under the limit, returns the whole text", () => {
    expect(readDocumentPart(DOC, { maxTokens: 10_000, sectionHint: hint })).toBe(DOC);
  });

  test("a section over the limit is outlined by its own subheadings", () => {
    const out = readDocumentPart(DOC, { section: "Alpha", maxTokens: 5, sectionHint: hint });
    expect(out).toContain('The section "Alpha" is ~');
    expect(out).toMatch(/^- ## Alpha \(~\d+ tokens\)$/m);
    expect(out).toMatch(/^ {2}- ### Alpha one/m);
    expect(out).not.toContain("## Beta");
  });

  test("the outline can exceed max_tokens: it is the threshold, not a cap", () => {
    const frontmatter = `---\nnotes: "${"n".repeat(400)}"\n---\n`;
    const out = readDocumentPart(`${frontmatter}\n## A\n\n${"a".repeat(400)}\n`, { maxTokens: 20, sectionHint: hint });
    expect(out.startsWith(frontmatter)).toBe(true);
    expect(out).toMatch(/^- ## A \(~\d+ tokens\)$/m);
    expect(out.length / 4).toBeGreaterThan(20);
  });

  test("a document with no headings says it cannot be read by section", () => {
    const out = readDocumentPart("x".repeat(400), { maxTokens: 10, sectionHint: hint });
    expect(out).toContain("has no headings");
    expect(out).not.toContain("xxxx");
  });
});

const section = (doc: string, name: string) => readDocumentPart(doc, { section: name, sectionHint: hint });

describe("fenced and indented code", () => {
  test("a shorter run of the same character does not close a fence", () => {
    const doc = "## A\n````\n```\n## Fake\n````\nafter\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\n````\n```\n## Fake\n````\nafter\n");
  });

  test("a tilde fence closes only on a bare run of tildes", () => {
    const doc = "## A\n~~~\n~~~more\n## Fake\n~~~\nafter\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\n~~~\n~~~more\n## Fake\n~~~\nafter\n");
  });

  test("a closing marker with text after it does not close a backtick fence", () => {
    const doc = "## A\n```\n``` not a close\n## Fake\n```\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\n```\n``` not a close\n## Fake\n```\n");
  });

  test("a backtick fence does not close on tildes, nor a tilde fence on backticks", () => {
    expect(section("## A\n```\n~~~\n## Fake\n```\n## B\n", "A")).toBe("## A\n```\n~~~\n## Fake\n```\n");
    expect(section("## A\n~~~\n```\n## Fake\n~~~\n## B\n", "A")).toBe("## A\n~~~\n```\n## Fake\n~~~\n");
  });

  test("a fence may be indented up to three spaces", () => {
    expect(section("## A\n   ```\n## Fake\n   ```\n## B\n", "A")).toBe("## A\n   ```\n## Fake\n   ```\n");
  });

  test("a four-space-indented marker is indented code, not a fence", () => {
    const doc = "## A\n\n    ```\n\n## B\nb\n";
    expect(section(doc, "B")).toBe("## B\nb\n");
  });

  test("a four-space-indented heading is indented code", () => {
    expect(() => section("## A\n\n    ## Fake\n", "Fake")).toThrow(SectionNotFoundError);
  });
});

describe("headings", () => {
  test("an ATX heading may be indented up to three spaces and carry closing #s", () => {
    expect(section("   ## Alpha ###\nbody\n## B\n", "Alpha")).toBe("   ## Alpha ###\nbody\n");
    expect(section("## C#\nbody\n", "C#")).toBe("## C#\nbody\n");
  });

  test("a setext heading is a section, from its text to the next heading", () => {
    const doc = "Title\n=====\n\nintro\n\nAlpha\n-----\nalpha body\n\nBeta\n----\nbeta body\n";
    // Cut by offset: the blank line before the next heading comes with it.
    expect(section(doc, "alpha")).toBe("Alpha\n-----\nalpha body\n\n");
    expect(section(doc, "title")).toBe(doc);
  });

  test("a setext heading may span several lines", () => {
    expect(section("Big\ntitle\n===\nbody\n", "big title")).toBe("Big\ntitle\n===\nbody\n");
  });

  test("--- after a blank line, a list item or a blockquote is not a setext underline", () => {
    for (const doc of ["para\n\n---\n## B\n", "- item\n---\n## B\n", "> quote\n---\n## B\n"]) {
      expect(() => section(doc, doc.split("\n")[0].replace(/^[-> ]+/, ""))).toThrow('available headings: "B"');
    }
  });

  test("a lazy line continuing a list item or blockquote is not a setext heading", () => {
    for (const doc of ["- item\ncontinued\n---\n## B\n", "> quote\ncontinued\n---\n## B\n"]) {
      expect(() => section(doc, "continued")).toThrow('available headings: "B"');
    }
  });

  test("indented code under --- is not a setext heading", () => {
    expect(() => section("intro\n\n    code line\n---\n## B\n", "code line")).toThrow('available headings: "B"');
  });

  test("an indented line continues a paragraph that a setext underline then makes a heading", () => {
    expect(section("Long\n    title\n---\nbody\n", "long title")).toBe("Long\n    title\n---\nbody\n");
  });

  test("a setext underline inside a fence is content", () => {
    expect(() => section("```\nFake\n---\n```\n", "Fake")).toThrow("the document has no headings");
  });

  test("selection matches visible text, not markup", () => {
    const doc = "## **Alpha** `x_y` [link](https://example.com) [[plan|the plan]] \\*\nbody\n";
    const out = section(doc, "alpha x_y link the plan *");
    expect(out).toBe(doc);
    expect(section("## snake_case and 2 * 3\nb\n", "snake_case and 2 * 3")).toBe("## snake_case and 2 * 3\nb\n");
  });

  test("the outline and the unknown-section error show visible text", () => {
    const doc = "## **Alpha** &amp; `b*c*`\n\n" + "x".repeat(200) + "\n";
    expect(() => section(doc, "Gamma")).toThrow('available headings: "Alpha & b*c*"');
    const outline = readDocumentPart(doc, { maxTokens: 10, sectionHint: hint });
    expect(outline).toMatch(/^- ## Alpha & b\*c\* \(~\d+ tokens\)$/m);
    expect(outline).not.toContain("**Alpha**");
  });

  test("a heading's name is its parsed inline text, and the query is taken literally", () => {
    expect(section("## foo*bar*baz\nx\n", "foobarbaz")).toBe("## foo*bar*baz\nx\n");
    expect(section("## A &amp; B\nx\n", "A & B")).toBe("## A &amp; B\nx\n");
    expect(section("## `*foo*`\nx\n", "*foo*")).toBe("## `*foo*`\nx\n");
    // A query spelled as markdown is not parsed again.
    expect(() => section("## Alpha\nx\n", "**Alpha**")).toThrow(SectionNotFoundError);
  });

  test("unequal letters stay unequal under folding: dotless ı is not I", () => {
    expect(section("## I\nfirst\n## ı\nsecond\n", "ı")).toBe("## ı\nsecond\n");
    expect(section("## I\nfirst\n## ı\nsecond\n", "i")).toBe("## I\nfirst\n");
  });

  test("case is folded in full: ß matches SS, and final and medial sigma match", () => {
    expect(section("## Straße\nx\n", "STRASSE")).toBe("## Straße\nx\n");
    expect(section("## STRASSE\nx\n", "straße")).toBe("## STRASSE\nx\n");
    expect(section("## ος\nx\n", "οσ")).toBe("## ος\nx\n");
    expect(section("## ΟΔΟΣ\nx\n", "οδος")).toBe("## ΟΔΟΣ\nx\n");
  });

  test("accents are not folded away", () => {
    expect(() => section("## école\nx\n", "ecole")).toThrow(SectionNotFoundError);
    expect(section("## École\nx\n", "ÉCOLE")).toBe("## École\nx\n");
  });

  test("when two headings match, the first is returned", () => {
    expect(section("## Alpha\nfirst\n## Alpha\nsecond\n", "alpha")).toBe("## Alpha\nfirst\n");
  });
});

describe("blocks the parser keeps headings out of", () => {
  test("a fence inside a list item hides the heading-like line it holds", () => {
    const doc = "## A\n- ```\n  ## Fake\n  ```\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\n- ```\n  ## Fake\n  ```\n");
    expect(section(doc, "B")).toBe("## B\nb\n");
  });

  test("a setext heading after a list-contained fence is still a heading", () => {
    const doc = "- ```\n  code\n  ```\n\nTitle\n-----\nbody\n";
    expect(section(doc, "Title")).toBe("Title\n-----\nbody\n");
  });

  for (const [name, block] of [
    ["an HTML comment", "<!--\n## Fake\n-->"],
    ["a <pre> block", "<pre>\n## Fake\n</pre>"],
    ["a <div> block", "<div>\n## Fake\n</div>"],
    ["a comment holding a setext underline", "<!--\nFake\n---\n-->"],
  ]) {
    test(`${name} is not a section boundary`, () => {
      // A <div> block ends only at a blank line, so every case leaves one.
      const doc = `## A\n${block}\n\nafter\n## B\nb\n`;
      expect(section(doc, "A")).toBe(`## A\n${block}\n\nafter\n`);
      expect(() => section(doc, "Fake")).toThrow('available headings: "A", "B"');
    });
  }

  test("a table followed by a thematic break is not a setext heading", () => {
    const doc = "## A\n| H |\n| --- |\n| row |\n---\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\n| H |\n| --- |\n| row |\n---\n");
  });

  test("a heading inside a blockquote or list item does not open a section", () => {
    expect(() => section("> ## Quoted\n\n## B\n", "Quoted")).toThrow('available headings: "B"');
    expect(() => section("- ## Listed\n\n## B\n", "Listed")).toThrow('available headings: "B"');
  });
});

describe("frontmatter and line endings", () => {
  test("an empty frontmatter block ends at its closing ---", () => {
    const doc = "---\n---\n## A\nbody\n\n---\n## B\nb\n";
    expect(section(doc, "A")).toBe("## A\nbody\n\n---\n");
    const outline = readDocumentPart(doc, { maxTokens: 1, sectionHint: hint });
    expect(outline.startsWith("---\n---\n\n[")).toBe(true);
    expect(outline).not.toContain("body");
  });

  test("the frontmatter span is the one gray-matter reads", () => {
    for (const doc of [
      "---\n---\n## A\n",
      "---\ntitle: T\n---\n## A\n",
      "---\r\ntitle: T\r\n---\r\n## A\r\n",
      "----\nnot frontmatter\n",
      "---\nunterminated\n",
      "## no frontmatter\n",
      "\uFEFF---\ntitle: T\n---\n## A\n",
      "\uFEFF## no frontmatter\n",
    ]) {
      // gray-matter strips a leading byte order mark from what it returns.
      const body = parseFrontmatter(doc).content;
      expect({ doc, body: doc.slice(frontmatterLength(doc)).replace(/^\uFEFF/, "") }).toEqual({ doc, body });
    }
  });

  test("frontmatter after a byte order mark is still frontmatter, for selection and outline", () => {
    const doc = "\uFEFF---\nnotes: |\n  ## A\n---\n## A\nbody\n";
    expect(section(doc, "A")).toBe("## A\nbody\n");
    const outline = readDocumentPart(doc, { maxTokens: 1, sectionHint: hint });
    expect(outline.startsWith("\uFEFF---\nnotes: |\n  ## A\n---\n\n[")).toBe(true);
    expect(outline.match(/^- ## /gm)).toEqual(["- ## "]);
  });

  test("CR-only and CRLF documents have headings too, cut byte for byte", () => {
    expect(section("## A\rx\r## B\ry\r", "A")).toBe("## A\rx\r");
    expect(section("## A\r\nx\r\n## B\r\ny\r\n", "B")).toBe("## B\r\ny\r\n");
  });
});

describe("outlining a selected section", () => {
  test("subheadings keep what the rest of the document gives them, like a reference link", () => {
    const doc = "## A\n\n### [Child][ref]\nbody\n## B\n\n[ref]: https://example.com\n";
    const outline = readDocumentPart(doc, { section: "A", maxTokens: 1, sectionHint: hint });
    expect(outline).toContain("- ### Child (~");
    expect(outline).not.toContain("[Child][ref]");
    // The listed name selects the subsection.
    expect(section(doc, "Child")).toBe("### [Child][ref]\nbody\n");
  });

  test("the sub-outline holds the section's own headings and counts them within it", () => {
    const doc = "## A\n\n### A1\n" + "a".repeat(40) + "\n### A2\nx\n## B\n### B1\n";
    const outline = readDocumentPart(doc, { section: "A", maxTokens: 1, sectionHint: hint });
    expect(outline).toContain("- ## A (~16 tokens)\n  - ### A1 (~12 tokens)\n  - ### A2 (~3 tokens)\n");
    expect(outline).not.toContain("B1");
  });
});
