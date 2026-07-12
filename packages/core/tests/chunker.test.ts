import { describe, expect, test } from "bun:test";

import { chunkDocument, chunkTextForEmbedding } from "../src/lib/chunker";

describe("chunkDocument", () => {
  test("returns a single chunk for a small document", () => {
    const chunks = chunkDocument({
      title: "Test",
      documentId: 1,
      content: "## Section\n\n" + "word ".repeat(150),
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe("Section");
    expect(chunks[0].chunk_index).toBe(0);
  });

  test("merges small sections into the next section", () => {
    const content = [
      "## Tiny",
      "short",
      "## Big",
      "word ".repeat(600),
    ].join("\n\n");
    const chunks = chunkDocument({ title: "Test", documentId: 1, content });
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain("## Tiny");
    expect(chunks[0].content).toContain("short");
  });

  test("splits oversized sections at paragraph boundaries", () => {
    const paragraphs = Array.from({ length: 10 }, () => "word ".repeat(200)).join("\n\n");
    const chunks = chunkDocument({
      title: "Test",
      documentId: 1,
      content: `## Huge\n\n${paragraphs}`,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].heading).toBe("Huge");
    expect(chunks[1].heading).toBe("Huge (cont.)");
  });

  test("returns empty array for empty content", () => {
    expect(chunkDocument({ title: "T", documentId: 1, content: "" })).toEqual([]);
  });

  test("does not split on ## headings inside fenced code blocks", () => {
    const content = [
      "## Real Section",
      "",
      "word ".repeat(150),
      "",
      "```markdown",
      "## Not A Heading",
      "code line",
      "```",
      "",
      "more text after the fence",
    ].join("\n");
    const chunks = chunkDocument({ title: "Test", documentId: 1, content });
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe("Real Section");
    expect(chunks[0].content).toContain("## Not A Heading");
  });

  test("resumes splitting on headings after a fence closes", () => {
    const content = [
      "## First",
      "",
      "word ".repeat(150),
      "",
      "```",
      "## Fenced",
      "```",
      "",
      "## Second",
      "",
      "word ".repeat(150),
    ].join("\n");
    const chunks = chunkDocument({ title: "Test", documentId: 1, content });
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("First");
    expect(chunks[0].content).toContain("## Fenced");
    expect(chunks[1].heading).toBe("Second");
  });

  test("tracks tilde fences and does not close them with backticks", () => {
    const content = [
      "## Section",
      "",
      "word ".repeat(150),
      "",
      "~~~",
      "```",
      "## Inside Tilde Fence",
      "~~~",
      "",
      "tail",
    ].join("\n");
    const chunks = chunkDocument({ title: "Test", documentId: 1, content });
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain("## Inside Tilde Fence");
  });
});

describe("chunkTextForEmbedding", () => {
  test("prepends title and heading", () => {
    expect(chunkTextForEmbedding("Doc", "Sec", "body")).toBe("[Doc] [Sec]\nbody");
  });

  test("includes context line when provided", () => {
    const text = chunkTextForEmbedding("Doc", "Sec", "body", "This chunk covers X.");
    expect(text).toBe("[Doc] [Sec]\nThis chunk covers X.\nbody");
  });

  test("omits context line when null", () => {
    expect(chunkTextForEmbedding("Doc", "Sec", "body", null)).toBe("[Doc] [Sec]\nbody");
  });
});
