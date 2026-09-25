import { describe, expect, test } from "bun:test";

import { aggregate, EvalSetError, parseEvalSet, parseKs, poolSize, scoreQuery } from "../src/lib/retrieval-eval";
import type { SearchResult } from "../src/lib/types";

const line = (value: object) => JSON.stringify(value);
const query = { id: "q1", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] };

function results(...paths: string[]): SearchResult[] {
  return paths.map((path, i) => ({
    path, title: path, type: "note", relevance: "secondary", status: "active",
    summary: null, tags: "", score: 10 - i, snippet: "",
  }));
}

describe("parseEvalSet", () => {
  test("reads one query per line and skips blank lines", () => {
    const set = parseEvalSet([line(query), "", line({ ...query, id: "q2", lang: "en" }), ""].join("\n"));
    expect(set.header).toBeNull();
    expect(set.queries.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(set.queries[1].lang).toBe("en");
  });

  test("a first line with neither id nor q is the header", () => {
    const set = parseEvalSet([line({}), line(query)].join("\n"));
    expect(set.header).toEqual({});
    expect(set.queries).toHaveLength(1);
  });

  test("a header key this version does not evaluate is refused, not ignored", () => {
    expect(() => parseEvalSet([line({ now: "2026-07-12" }), line(query)].join("\n"))).toThrow(
      /line 1: header key "now" is not supported/
    );
  });

  test("a header-shaped object after the first line is a malformed query", () => {
    expect(() => parseEvalSet([line(query), line({})].join("\n"))).toThrow(/^line 2: /);
  });

  test("an empty expected requires class no-answer, and no-answer requires it empty", () => {
    expect(() => parseEvalSet(line({ ...query, expected: [] }))).toThrow(/line 1: .*requires class "no-answer"/);
    expect(() => parseEvalSet(line({ ...query, class: "no-answer" }))).toThrow(/line 1: .*must have an empty "expected"/);
    expect(parseEvalSet(line({ ...query, class: "no-answer", expected: [] })).queries).toHaveLength(1);
  });

  test("names the line of invalid JSON, a missing field, an unknown field and a duplicate id", () => {
    expect(() => parseEvalSet([line(query), "{not json"].join("\n"))).toThrow(/^line 2: not valid JSON/);
    expect(() => parseEvalSet(line({ id: "x", class: "exact", expected: ["a.md"] }))).toThrow(/^line 1: q: /);
    expect(() => parseEvalSet(line({ ...query, expect: ["a.md"] }))).toThrow(/^line 1: .*expect/);
    expect(() => parseEvalSet([line(query), "", line(query)].join("\n"))).toThrow(
      'line 3: duplicate id "q1" (first on line 1)'
    );
  });

  test("errors are EvalSetError, so the CLI can report them as usage errors", () => {
    expect(() => parseEvalSet("[]")).toThrow(EvalSetError);
  });
});

describe("parseKs and poolSize", () => {
  test("sorted, distinct positive integers", () => {
    expect(parseKs("10, 1,3,1")).toEqual([1, 3, 10]);
    for (const bad of ["0", "1,,3", "a", "1.5", "-1"]) expect(() => parseKs(bad)).toThrow(EvalSetError);
  });

  test("the pool is at least the search default and never smaller than the largest k", () => {
    expect(poolSize([1, 3, 10])).toBe(20);
    expect(poolSize([1, 50])).toBe(50);
  });
});

describe("scoreQuery and aggregate", () => {
  const ks = [1, 3, 10];

  test("rank is the first expected path's position; any expected path counts", () => {
    const outcome = scoreQuery("fts", { ...query, expected: ["b.md", "c.md"] }, results("a.md", "c.md", "b.md"), ks);
    expect(outcome.rank).toBe(2);
    expect(outcome.hit_at).toEqual({ "1": false, "3": true, "10": true });
    expect(outcome.rr).toBe(0.5);
  });

  test("a hit past the MRR cutoff scores rr 0 but still counts for the oracle", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `d${i}.md`);
    const outcome = scoreQuery("fts", { ...query, expected: ["d11.md"] }, results(...paths), ks);
    expect(outcome.rank).toBe(12);
    expect(outcome.rr).toBe(0);
    expect(outcome.top).toHaveLength(10);
    const [overall] = aggregate("fts", [outcome], ks);
    expect(overall.oracle).toBe(1);
    expect(overall.hit_at).toEqual({ "1": 0, "3": 0, "10": 0 });
  });

  test("the overall row covers answerable queries only; each class gets its own row", () => {
    const outcomes = [
      scoreQuery("fts", query, results("studies/telescope-setup.md"), ks),
      scoreQuery("fts", { ...query, id: "q2", class: "alias" }, results("x.md", "studies/telescope-setup.md"), ks),
      scoreQuery("fts", { ...query, id: "q3", class: "no-answer", expected: [] }, results("x.md"), ks),
    ];
    const rows = aggregate("fts", outcomes, ks);
    expect(rows.map((r) => [r.class, r.n])).toEqual([[null, 2], ["exact", 1], ["alias", 1], ["no-answer", 1]]);
    expect(rows[0].hit_at!["1"]).toBe(0.5);
    expect(rows[0].mrr_at_10).toBe(0.75);
    expect(rows[3]).toMatchObject({ hit_at: null, mrr_at_10: null, oracle: null, top1_score_median: 10 });
  });

  test("a set of only no-answer queries has no overall row", () => {
    const outcome = scoreQuery("fts", { ...query, class: "no-answer", expected: [] }, [], ks);
    expect(outcome.top1_score).toBeNull();
    expect(aggregate("fts", [outcome], ks).map((r) => r.class)).toEqual(["no-answer"]);
  });
});
