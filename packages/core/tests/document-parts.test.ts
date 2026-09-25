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
    expect(out).toMatch(/^- ## Alpha \(~\d+ tokens\)$/m);
    expect(out).toMatch(/^ {2}- ### Alpha one \(~\d+ tokens\)$/m);
    expect(out).toMatch(/^- ## Beta \(~\d+ tokens\)$/m);
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

  test("a document with no headings says it cannot be read by section", () => {
    const out = readDocumentPart("x".repeat(400), { maxTokens: 10, sectionHint: hint });
    expect(out).toContain("has no headings");
    expect(out).not.toContain("xxxx");
  });
});
