import { describe, expect, test } from "bun:test";
import { openableSearchPath, parseSearchResults } from "../src/lib/search-results.js";

describe("existing search result formats", () => {
  test("core JSON retains all hits, finite scores, warnings and nullable snippets", () => {
    const results = [{ path: "knowledge/scylla.md", title: "Scylla", score: -2, snippet: null }, { path: "people/penelope.md", title: "Penelope", snippet: "wait" }];
    expect(parseSearchResults(JSON.stringify({ results, warnings: ["FTS only"] }))).toEqual({ results, warnings: ["FTS only"] });
  });
  test("pi text retains each ordered hit and all marked text, without fabricating scores", () => {
    expect(parseSearchResults("> FTS only\n- knowledge/scylla.md — Scylla [note]\n    >>>six heads<<< and >>>row<<<\n- people/penelope.md — Penelope [person]"))
      .toEqual({ results: [{ path: "knowledge/scylla.md", title: "Scylla", type: "note", snippet: ">>>six heads<<< and >>>row<<<" }, { path: "people/penelope.md", title: "Penelope", type: "person", snippet: "" }], warnings: ["FTS only"] });
  });
  test("pi empty results keep their warnings", () => {
    expect(parseSearchResults("> index warning\nNo results found.")).toEqual({ results: [], warnings: ["index warning"] });
  });
  for (const output of ["denied", "{}", '{"results":[{}],"warnings":[]}', '{"results":[],"warnings":[42]}', '{"results":[{"path":"notes/a.md","title":"A","score":"0.9"}],"warnings":[]}',
    "- knowledge/scylla.md — Scylla [note]\n… [truncated 12 bytes]",
    "- knowledge/scylla.md — Scylla — crossing [note]", "- knowledge/scylla.md — Scylla [note]\nraw unindented continuation"]) {
    test(`unrecognised output stays in the readable fallback: ${output}`, () => expect(parseSearchResults(output)).toBeNull());
  }
  test("unsafe navigation paths are never accepted", () => {
    for (const path of ["../secret.md", "/etc/passwd", "https://example.com/a", "notes/../secret.md", "notes/./a.md", "notes//a.md", "notes/a\\b.md", "notes/a.md?x", "notes/a\u0000.md"]) expect(openableSearchPath(path)).toBe(false);
    expect(openableSearchPath("knowledge/scylla.md")).toBe(true);
    expect(openableSearchPath("knowledge/Straits of Scylla.md")).toBe(true);
  });
});
