import { describe, expect, test } from "bun:test";

import { chunkDocument, chunkTextForEmbedding, estimateTokens } from "../src/lib/chunker";

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

const MIN_TOKENS = 100;
const MAX_TOKENS = 1000;

describe("chunkDocument by structure (#426)", () => {
  const header = "| Id | Name | Notes |";
  const separator = "| --- | --- | --- |";
  const table = (rows: number) =>
    [header, separator, ...Array.from({ length: rows }, (_, i) => `| ${i} | Station ${i} | mooring mast log row ${i} |`)].join("\n");

  test("a 300-row table splits at row boundaries, each piece led by the header and separator rows", () => {
    const chunks = chunkDocument({ title: "T", documentId: 1, content: `## Registry\n\n${table(300)}` });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const lines = chunk.content.split("\n");
      expect(lines.slice(0, 2)).toEqual([header, separator]);
      expect(chunk.token_estimate).toBeLessThanOrEqual(MAX_TOKENS);
    }
    // Every row is kept, once.
    const rows = chunks.flatMap((c) => c.content.split("\n").slice(2));
    expect(rows).toEqual(table(300).split("\n").slice(2));
    expect(chunks.map((c) => c.heading)).toEqual(["Registry", ...chunks.slice(1).map(() => "Registry (cont.)")]);
  });

  test("a section over the limit with ### headings splits there first", () => {
    const sub = (name: string) => [`### ${name}`, "", `${name.toLowerCase()} `.repeat(300).trim(), ""];
    const content = ["## Fleet", "", "An overview line.", "", ...sub("Zeppelins"), ...sub("Blimps")].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    expect(chunks.map((c) => c.heading)).toEqual(["Fleet › Zeppelins", "Fleet › Blimps"]);
    expect(chunks[0].content).toContain("An overview line.");
    for (const chunk of chunks) expect(chunk.token_estimate).toBeLessThanOrEqual(MAX_TOKENS);
  });

  test("a document ending in a 3-line section leaves no chunk under MIN_TOKENS at the end", () => {
    const content = [
      "## Body", "", "word ".repeat(600).trim(), "",
      "## Related", "", "- [[one]]", "- [[two]]", "- [[three]]",
    ].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    expect(chunks.at(-1)!.token_estimate).toBeGreaterThanOrEqual(MIN_TOKENS);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain("## Related\n\n- [[one]]");
  });

  test("a trailing stub stays alone when folding it would pass MAX_TOKENS", () => {
    const content = ["## Body", "", "word ".repeat(800).trim(), "", "## Related", "", "- [[one]]"].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    expect(estimateTokens("word ".repeat(800).trim())).toBe(MAX_TOKENS);
    expect(chunks.map((c) => c.heading)).toEqual(["Body", "Related"]);
  });

  test("a fenced block holding a ### line and a table is never split inside the fence", () => {
    const fence = ["```markdown", "### Not a subheading", "", table(200), "", "```"].join("\n");
    const content = ["## Code", "", "word ".repeat(400).trim(), "", "### Real", "", fence, "", "word ".repeat(400).trim()].join("\n");
    expect(estimateTokens(content)).toBeGreaterThan(MAX_TOKENS);
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    const holding = chunks.filter((c) => c.content.includes("```markdown"));
    expect(holding.length).toBe(1);
    expect(holding[0].content).toContain(fence);
    expect(chunks.some((c) => c.heading.includes("Not a subheading"))).toBe(false);
  });

  test("no chunk passes MAX_TOKENS unless it is one line, one row or one fence", () => {
    const longLine = "x".repeat(MAX_TOKENS * 4 + 400);
    const content = ["## Mixed", "", "word ".repeat(900).trim(), "", table(120), "", longLine, "", "word ".repeat(300).trim()].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    const oversized = chunks.filter((c) => c.token_estimate > MAX_TOKENS);
    // Only single lines: the 900-word paragraph and the long line.
    expect(oversized.map((c) => c.content)).toEqual(["word ".repeat(900).trim(), longLine]);
    expect(chunks.length).toBeGreaterThan(3);
  });
});

describe("chunkDocument reads structure from the markdown parser (#426 review)", () => {
  const fits = (chunks: Array<{ token_estimate: number }>) => chunks.every((c) => c.token_estimate <= MAX_TOKENS);

  test("a fence right after a long paragraph line is never split, and its ### stays code", () => {
    const rows = Array.from({ length: 100 }, (_, i) => `| ${i} | row ${i} |`).join("\n");
    const fence = ["```text", "### inside", rows, "```"].join("\n");
    const content = ["## Log", "", "p".repeat(3000), fence].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    const holding = chunks.filter((c) => c.content.includes("```text"));
    expect(holding.length).toBe(1);
    expect(holding[0].content).toContain(fence);
    expect(chunks.some((c) => c.heading.includes("inside"))).toBe(false);
  });

  test("text after a short fence is split like any other text", () => {
    const content = ["## Log", "", "```", "x", "```", Array.from({ length: 1200 }, () => "abc").join("\n")].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    expect(chunks.length).toBeGreaterThan(1);
    expect(fits(chunks)).toBe(true);
  });

  test("a four-backtick fence holding a triple-backtick one and a ### line is one unit", () => {
    const inner = ["```js", "const a = 1;", "```"].join("\n");
    // Over MAX_TOKENS on its own, so only its being one unit keeps it whole.
    const fence = ["````markdown", "### inside", "", inner, "", ...Array.from({ length: 300 }, (_, i) => `text line ${i}`), "````"].join("\n");
    const content = ["## Docs", "", "word ".repeat(700).trim(), "", fence, "", "word ".repeat(300).trim()].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    const holding = chunks.filter((c) => c.content.includes("````markdown"));
    expect(holding.length).toBe(1);
    expect(holding[0].content).toContain(fence);
    expect(chunks.some((c) => c.heading.includes("inside"))).toBe(false);
  });

  test("a fence inside a list item stays whole when the list is split at lines", () => {
    const items = Array.from({ length: 60 }, (_, i) => `- item ${i} ${"word ".repeat(12).trim()}`);
    // Long enough that a line-based cut would land inside it.
    const fence = ["  ```sh", ...Array.from({ length: 200 }, (_, i) => `  echo line ${i}`), "  ```"].join("\n");
    const list = [...items.slice(0, 30), `- with code:\n\n${fence}\n`, ...items.slice(30)].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content: `## Steps\n\n${list}` });
    expect(chunks.length).toBeGreaterThan(1);
    const holding = chunks.filter((c) => c.content.includes("  ```sh"));
    expect(holding.length).toBe(1);
    expect(holding[0].content).toContain(fence);
  });

  test("a table without outer pipes repeats its header rows too", () => {
    const table = ["Name | Value", "--- | ---", ...Array.from({ length: 300 }, (_, i) => `station ${i} | value ${i}`)].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content: `## Registry\n\n${table}` });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.split("\n").slice(0, 2)).toEqual(["Name | Value", "--- | ---"]);
    expect(fits(chunks)).toBe(true);
  });

  test("a row that cannot fit even with the header alone goes out on its own, the stated exception", () => {
    const header = `| ${"h".repeat(3000)} |`;
    const row = `| ${"r".repeat(1500)} |`;
    const content = ["## Wide", "", header, "| --- |", row, "| short |"].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    expect(fits(chunks)).toBe(true);
    expect(chunks.map((c) => c.content)).toContain(row);
    expect(chunks.filter((c) => c.content.includes(header)).length).toBe(2); // opens the table, then leads "| short |"
    expect(chunks.find((c) => c.content.includes("| short |"))!.content.startsWith(header)).toBe(true);
  });
});

describe("chunkDocument's size bound, review round 2 (#426)", () => {
  const within = (chunks: Array<{ token_estimate: number }>) => chunks.every((c) => c.token_estimate <= MAX_TOKENS);

  test("a header that fits but whose separator tips it over is cut at lines, with and without data rows", () => {
    const header = `| ${"h".repeat(3990)} |`;
    for (const rows of [["| row |"], []]) {
      const content = ["## Wide", "", header, "| ----------- |", ...rows].join("\n");
      const chunks = chunkDocument({ title: "T", documentId: 1, content });
      expect(estimateTokens(header)).toBeLessThanOrEqual(MAX_TOKENS);
      expect(within(chunks)).toBe(true);
      expect(chunks.map((c) => c.content).join("\n")).toContain(header);
    }
  });

  test("a header line over the limit on its own is the single-line exception, table or not", () => {
    const header = `| ${"h".repeat(4400)} |`;
    const content = ["## Wide", "", header, "| --- |"].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content });
    const over = chunks.filter((c) => c.token_estimate > MAX_TOKENS);
    expect(over.length).toBe(1);
    expect(over[0].content.split("\n")[0]).toBe(header);
  });

  test("an HTML block over the limit is split at lines", () => {
    const html = ["<div>", ...Array.from({ length: 1000 }, () => "<p>abc</p>"), "</div>"].join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content: `## HTML\n\n${html}` });
    expect(chunks.length).toBeGreaterThan(1);
    expect(within(chunks)).toBe(true);
  });

  test("an indented code block is one unit, however it is sliced", () => {
    const code = Array.from({ length: 1200 }, () => "    x").join("\n");
    const chunks = chunkDocument({ title: "T", documentId: 1, content: `## Code\n\n${code}` });
    expect(chunks.map((c) => c.content)).toEqual([code]);
  });
});

describe("section boundaries follow CommonMark fences (#461)", () => {
  const body = "word ".repeat(150).trim();
  const headings = (content: string) => chunkDocument({ title: "T", documentId: 1, content }).map((c) => c.heading);
  /** The heading of the chunk that holds `text`: a ## line inside code stays in the section around it. */
  const holder = (content: string, text: string) =>
    chunkDocument({ title: "T", documentId: 1, content }).find((c) => c.content.includes(text))?.heading;

  test("a four-backtick fence is not closed by a three-backtick line, so its ## line is code", () => {
    const content = ["## First", "", body, "", "````md", "```", "## Inside", "```", "````", "", "## Second", "", body].join("\n");
    expect(holder(content, "## Inside")).toBe("First");
    expect(headings(content)).toEqual(["First", "Second"]);
  });

  test("a tilde fence is not closed by a marker with text after it", () => {
    const content = ["## First", "", body, "", "~~~", "~~~more", "## Inside", "~~~", "", "## Second", "", body].join("\n");
    expect(holder(content, "## Inside")).toBe("First");
    expect(headings(content)).toEqual(["First", "Second"]);
  });

  test("a marker indented four spaces is indented code, and the real heading after it still counts", () => {
    const content = ["## First", "", body, "", "    ```", "", "## Second", "", body].join("\n");
    expect(headings(content)).toEqual(["First", "Second"]);
  });
});
