import { describe, expect, test } from "bun:test";

import { readDocumentPart, SectionNotFoundError } from "../src/lib/document-parts";

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
    expect(section(doc, "alpha")).toBe("Alpha\n-----\nalpha body\n");
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
    expect(() => section("## **Alpha**\n", "Gamma")).toThrow('available headings: "Alpha"');
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
