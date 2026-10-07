import { describe, test, expect } from "bun:test";
import type { ToolCall } from "../src/stores/chat-store";
import {
  getToolSummary,
  getOutputMeta,
  getTouchedFile,
  toRepoRelative,
  fenceFor,
  countLines,
  formatDuration,
  safeSearchRegex,
  splitMatches,
  splitGrepRow,
  parseWebSearchResults,
  computeDiffRows,
  diffText,
} from "../src/components/chat/tool-views";

// Minimal ToolCall factory — only the fields the pure helpers read.
function tc(partial: Partial<ToolCall> & { name: string }): ToolCall {
  return {
    id: "t1",
    input: {},
    inputJson: "{}",
    status: "complete",
    ...partial,
  } as ToolCall;
}

// ----------------------------------------------------------------------------
// getToolSummary
// ----------------------------------------------------------------------------

describe("getToolSummary", () => {
  test("Bash prefers description over command", () => {
    expect(
      getToolSummary(tc({ name: "Bash", input: { description: "run tests", command: "bun test" } }))
    ).toBe("run tests");
  });

  test("Bash falls back to a truncated command", () => {
    const long = "echo " + "x".repeat(200);
    const out = getToolSummary(tc({ name: "Bash", input: { command: long } }));
    expect(out).toBe(long.slice(0, 80));
    expect(out!.length).toBe(80);
  });

  test("Read renders offset+limit range", () => {
    expect(
      getToolSummary(tc({ name: "Read", input: { file_path: "/data/brain/notes/foo.md", offset: 10, limit: 20 } }))
    ).toBe("foo.md · 10–30");
  });

  test("Read without range is just the basename", () => {
    expect(getToolSummary(tc({ name: "Read", input: { file_path: "/data/brain/notes/foo.md" } }))).toBe("foo.md");
  });

  test("WebFetch shortens to host + path", () => {
    expect(
      getToolSummary(tc({ name: "WebFetch", input: { url: "https://example.com/docs/page?x=1" } }))
    ).toBe("example.com/docs/page");
  });

  test("WebFetch drops a bare root path", () => {
    expect(getToolSummary(tc({ name: "WebFetch", input: { url: "https://example.com/" } }))).toBe("example.com");
  });

  test("Skill joins skill and args", () => {
    expect(getToolSummary(tc({ name: "Skill", input: { skill: "verify", args: "--fast" } }))).toBe("verify --fast");
  });

  test("LSP joins op and file basename", () => {
    expect(
      getToolSummary(tc({ name: "LSP", input: { operation: "definition", file_path: "/data/brain/src/x.ts" } }))
    ).toBe("definition · x.ts");
  });

  test("Grep returns the pattern", () => {
    expect(getToolSummary(tc({ name: "Grep", input: { pattern: "TODO" } }))).toBe("TODO");
  });

  test("no input yields null", () => {
    expect(getToolSummary(tc({ name: "Bash", input: undefined as unknown as Record<string, unknown> }))).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// getOutputMeta
// ----------------------------------------------------------------------------

describe("getOutputMeta", () => {
  test("Grep counts matches", () => {
    expect(getOutputMeta(tc({ name: "Grep", output: "a\nb\nc" }))).toBe("3 matches");
  });

  test("Grep reports no matches", () => {
    expect(getOutputMeta(tc({ name: "Grep", output: "No matches found" }))).toBe("no matches");
  });

  test("Glob pluralizes files", () => {
    expect(getOutputMeta(tc({ name: "Glob", output: "a.md\nb.md" }))).toBe("2 files");
    expect(getOutputMeta(tc({ name: "Glob", output: "only.md" }))).toBe("1 file");
  });

  test("Read counts lines", () => {
    expect(getOutputMeta(tc({ name: "Read", output: "l1\nl2\nl3\nl4" }))).toBe("4 lines");
  });

  test("appends a formatted duration", () => {
    expect(
      getOutputMeta(tc({ name: "Grep", output: "a\nb", startedAt: 1000, endedAt: 3500 }))
    ).toBe("2 matches · 2.5s");
  });

  test("errored output contributes no size meta", () => {
    expect(getOutputMeta(tc({ name: "Grep", output: "a\nb", isError: true }))).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// getTouchedFile
// ----------------------------------------------------------------------------

describe("getTouchedFile", () => {
  test("Edit returns file_path", () => {
    expect(getTouchedFile(tc({ name: "Edit", input: { file_path: "notes/foo.md" } }))).toBe("notes/foo.md");
  });
  test("Write returns file_path", () => {
    expect(getTouchedFile(tc({ name: "Write", input: { file_path: "notes/bar.md" } }))).toBe("notes/bar.md");
  });
  test("NotebookEdit returns notebook_path", () => {
    expect(getTouchedFile(tc({ name: "NotebookEdit", input: { notebook_path: "n.ipynb" } }))).toBe("n.ipynb");
  });
  test("non-writing tools return null", () => {
    expect(getTouchedFile(tc({ name: "Read", input: { file_path: "notes/foo.md" } }))).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// toRepoRelative
// ----------------------------------------------------------------------------

describe("toRepoRelative", () => {
  test("strips an absolute brain path to repo-relative", () => {
    expect(toRepoRelative("/data/brain/notes/foo.md")).toBe("notes/foo.md");
  });
  test("passes an already-relative path through", () => {
    expect(toRepoRelative("notes/foo.md")).toBe("notes/foo.md");
  });
  test("returns null for a non-repo path", () => {
    expect(toRepoRelative("/etc/passwd")).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// fenceFor
// ----------------------------------------------------------------------------

describe("fenceFor", () => {
  test("defaults to a triple backtick fence", () => {
    expect(fenceFor("plain text")).toBe("```");
  });
  test("grows past an embedded triple-backtick fence", () => {
    expect(fenceFor("before\n```js\ncode\n```\nafter")).toBe("````");
  });
  test("grows past a longer embedded fence", () => {
    expect(fenceFor("````\nx\n````")).toBe("`````");
  });
});

// ----------------------------------------------------------------------------
// formatDuration
// ----------------------------------------------------------------------------

describe("formatDuration", () => {
  test("sub-second", () => {
    expect(formatDuration(500)).toBe("0.5s");
  });
  test("seconds", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });
  test("minute boundary", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});

// ----------------------------------------------------------------------------
// countLines
// ----------------------------------------------------------------------------

describe("countLines", () => {
  test("single line has no newline", () => {
    expect(countLines("one line")).toBe(1);
  });
  test("counts newlines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

// ----------------------------------------------------------------------------
// safeSearchRegex + splitMatches (Grep highlighter regex safety)
// ----------------------------------------------------------------------------

describe("safeSearchRegex", () => {
  test("compiles a plain term", () => {
    const re = safeSearchRegex("todo");
    expect(re).not.toBeNull();
    expect("a TODO here".match(re!)).not.toBeNull();
  });

  test("a pathological pattern like c++ never throws and matches literally", () => {
    expect(() => safeSearchRegex("c++")).not.toThrow();
    const re = safeSearchRegex("c++");
    expect(re).not.toBeNull();
    expect(splitMatches("code in c++ here", re!).some((s) => s.match && s.text === "c++")).toBe(true);
  });

  test("unbalanced patterns fall back to literal without throwing", () => {
    for (const p of ["(", "*", "[", "a(b"]) {
      expect(() => safeSearchRegex(p)).not.toThrow();
      const re = safeSearchRegex(p);
      expect(re).not.toBeNull();
      expect(splitMatches(`before ${p} after`, re!)).toEqual([
        { text: "before ", match: false },
        { text: p, match: true },
        { text: " after", match: false },
      ]);
    }
  });

  test("null pattern yields null", () => {
    expect(safeSearchRegex(null)).toBeNull();
  });

  test("quantifier-free patterns compile as real regexes", () => {
    // Alternation without unbounded repetition is ReDoS-safe, so it stays a
    // real regex and matches either branch.
    const re = safeSearchRegex("error|warn")!;
    expect(splitMatches("an error and a warn", re).filter((s) => s.match).map((s) => s.text)).toEqual([
      "error",
      "warn",
    ]);
  });

  test("a ReDoS-prone pattern is defused (matched literally, runs fast)", () => {
    // `(a+)+$` would backtrack exponentially if compiled as a real regex; the
    // `+` forces the escaped-literal path, which is linear.
    const re = safeSearchRegex("(a+)+$")!;
    expect(splitMatches("before (a+)+$ after", re)).toEqual([
      { text: "before ", match: false },
      { text: "(a+)+$", match: true },
      { text: " after", match: false },
    ]);
    const start = performance.now();
    splitMatches("a".repeat(40) + "X", re); // would hang for seconds if unsafe
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe("splitMatches", () => {
  test("splits into non-match and match segments", () => {
    const re = safeSearchRegex("bar")!;
    expect(splitMatches("foo bar baz bar", re)).toEqual([
      { text: "foo ", match: false },
      { text: "bar", match: true },
      { text: " baz ", match: false },
      { text: "bar", match: true },
    ]);
  });

  test("a zero-width-capable pattern does not spin", () => {
    // `\b` compiles as a real regex (no unbounded quantifier) and matches
    // zero-width at word boundaries — splitMatches must skip those, not spin.
    const re = safeSearchRegex("\\b")!;
    const segs = splitMatches("banana bread", re);
    expect(segs.map((s) => s.text).join("")).toBe("banana bread");
    expect(segs.every((s) => !s.match)).toBe(true);
  });
});

describe("splitGrepRow", () => {
  test("splits path:line:content so only content is highlighted", () => {
    expect(splitGrepRow("server/src/index.ts:42:  await deploy(config)")).toEqual({
      prefix: "server/src/index.ts:42:",
      content: "  await deploy(config)",
    });
  });
  test("keeps a term that appears in the path out of the content", () => {
    // The `deploy` in the path must live in the prefix, not the highlightable content.
    const split = splitGrepRow("scripts/deploy.sh:1:# deploy script")!;
    expect(split.prefix).toBe("scripts/deploy.sh:1:");
    expect(split.content).toBe("# deploy script");
  });
  test("returns null for rows without a path:line: prefix", () => {
    expect(splitGrepRow("src/lib/util.ts")).toBeNull();
    expect(splitGrepRow("just some text")).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// parseWebSearchResults
// ----------------------------------------------------------------------------

describe("parseWebSearchResults", () => {
  test("parses JSON-style {title,url} entries", () => {
    const out = `Links: [
      {"title": "First Result", "url": "https://a.example.com/1"},
      {"title": "Second Result", "url": "https://b.example.com/2"},
      {"title": "Third Result", "url": "https://c.example.com/3"}
    ]`;
    const results = parseWebSearchResults(out);
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({ title: "First Result", url: "https://a.example.com/1" });
  });

  test("parses markdown links", () => {
    const out = "- [Alpha](https://a.test/1)\n- [Beta](https://b.test/2)\n- [Gamma](https://c.test/3)";
    const results = parseWebSearchResults(out);
    expect(results.map((r) => r.url)).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3"]);
  });

  test("parses a title-then-url line layout", () => {
    const out = "1. How to Foo\n   https://foo.test/guide\n2. Bar Basics\n   https://bar.test/intro";
    const results = parseWebSearchResults(out);
    expect(results.length).toBe(2);
    expect(results[0]).toEqual({ title: "How to Foo", url: "https://foo.test/guide" });
  });

  test("de-duplicates repeated URLs", () => {
    const out = `{"title": "A", "url": "https://x.test/1"} {"title": "A again", "url": "https://x.test/1"}`;
    expect(parseWebSearchResults(out).length).toBe(1);
  });

  test("keeps balanced brackets inside a URL, trims trailing punctuation", () => {
    const out = "Function (mathematics)\nhttps://en.wikipedia.org/wiki/Function_(mathematics).";
    const results = parseWebSearchResults(out);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
  });

  test("strips an unbalanced trailing bracket", () => {
    const out = "See Foo\n(https://foo.test/page)";
    // The leading `(` is not part of the URL capture; the trailing `)` is
    // unbalanced within the URL and should be trimmed.
    expect(parseWebSearchResults(out)[0].url).toBe("https://foo.test/page");
  });

  test("garbage input returns no entries and never throws", () => {
    expect(() => parseWebSearchResults("no links at all, just prose")).not.toThrow();
    expect(parseWebSearchResults("no links at all, just prose")).toEqual([]);
    expect(parseWebSearchResults("")).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// EditDiffView's input: the Edit tool's old/new strings as the signed text
// the kit DiffBlock (tinted) reads. The rows are the line diff; there is no
// word-level highlight any more — the sign and the ground are the vocabulary.
// ----------------------------------------------------------------------------

describe("EditDiffView text", () => {
  test("old_string / new_string become signed rows for the kit DiffBlock", () => {
    const text = diffText(computeDiffRows("seats: 40\nvenue: hall", "seats: 24\nvenue: hall"));
    expect(text.split("\n")).toEqual(["- seats: 40", "+ seats: 24", "  venue: hall"]);
  });

  test("rows carry no word tokens", () => {
    const rows = computeDiffRows("the quick brown fox", "the quick red fox");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["kind", "line"]);
    }
  });
});
