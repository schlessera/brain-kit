import { describe, expect, test } from "bun:test";

import { aggregate, ContaminationScanner, EvalSetError, isCalendarDate, MAX_K, parseEvalDate, parseEvalSet, parseKs, poolSize, scoreQuery, selectPaths } from "../src/lib/retrieval-eval";
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

  test("the header pins now; an unknown header key or a bad date is refused, not ignored", () => {
    expect(parseEvalSet([line({ now: "2026-07-12" }), line(query)].join("\n")).header).toEqual({ now: "2026-07-12" });
    expect(() => parseEvalSet([line({ today: "2026-07-12" }), line(query)].join("\n"))).toThrow(/^line 1: header: /);
    expect(() => parseEvalSet([line({ now: "2026-02-30x" }), line(query)].join("\n"))).toThrow(/^line 1: header: now: /);
    expect(() => parseEvalSet([line({ now: "yesterday" }), line(query)].join("\n"))).toThrow(/^line 1: header: now: /);
  });

  test("a query gives expected or a selector, never both or neither", () => {
    const select = { field: "deadline", after: "now", order: "asc" as const, take: 1 };
    expect(parseEvalSet(line({ id: "s", q: "due next", class: "time", expect: { select } })).queries[0].expect).toEqual({ select });
    const { expected: _drop, ...bare } = query;
    expect(() => parseEvalSet(line(bare))).toThrow(/exactly one of "expected" and "expect"/);
    expect(() => parseEvalSet(line({ ...query, expect: { select } }))).toThrow(/exactly one of "expected" and "expect"/);
    expect(() => parseEvalSet(line({ ...bare, expect: { select: { ...select, before: "now" } } }))).toThrow(/after or before, not both/);
    expect(() => parseEvalSet(line({ ...bare, expect: { select: { ...select, take: 0 } } }))).toThrow(/^line 1: /);
    expect(() => parseEvalSet(line({ ...query, stale: [] }))).toThrow(/^line 1: stale: /);
    expect(() => parseEvalSet(line({ ...query, class: "no-answer", expected: [], stale: ["a.md"] }))).toThrow(/no current answer/);
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

  test("a cutoff above MAX_K, unsafe or infinite is refused, not rounded", () => {
    expect(parseKs(String(MAX_K))).toEqual([MAX_K]);
    for (const bad of [String(MAX_K + 1), "9007199254740993", "9".repeat(400)]) {
      expect(() => parseKs(bad)).toThrow(`--k cutoffs go up to ${MAX_K}`);
    }
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

describe("ContaminationScanner", () => {
  const q = (id: string, text: string) => ({ ...query, id, q: text });
  const scan = (queries: ReturnType<typeof q>[], ...docs: string[]) => {
    const scanner = new ContaminationScanner(queries);
    docs.forEach((text, i) => scanner.scan(`d${i}.md`, text));
    return scanner.warnings();
  };

  test("matches whole words only, never inside a longer word", () => {
    const short = [q("cat", "cat"), q("dog", "dog"), q("owl", "owl")];
    expect(scan(short, "concatenate dogmatic owlet")).toEqual([]);
    expect(scan(short, "A cat, a dog (and) an owl.")).toEqual([
      "contamination: d0.md contains the text of 3 of the set's queries (cat, dog, owl)",
    ]);
    const long = [q("scope", "how is the telescope")];
    expect(scan(long, "Somehow is the telescoped mirror aligned")).toEqual([]);
    expect(scan(long, "So: HOW is the\n  telescope?")).toEqual([
      "contamination: d0.md contains the text of 1 of the set's queries (scope)",
    ]);
  });

  test("four words is enough on its own; three words is not", () => {
    expect(scan([q("four", "when is the deadline")], "notes: when is the deadline")).toHaveLength(1);
    expect(scan([q("three", "the next deadline")], "notes: the next deadline")).toEqual([]);
  });

  test("three queries of any length are enough; two are not", () => {
    const set = [q("a", "knee"), q("b", "sleep"), q("c", "trail")];
    expect(scan(set, "knee and sleep")).toEqual([]);
    expect(scan(set, "knee, sleep, trail")).toHaveLength(1);
  });

  test("a query with regex characters is matched literally", () => {
    expect(scan([q("re", "what is (a+b)* in c++ code")], "what is (a+b)* in c++ code")).toHaveLength(1);
    expect(scan([q("re", "what is (a+b)* in c++ code")], "what is aab in c code")).toEqual([]);
  });
});

describe("current_first", () => {
  const ks = [1, 3, 10];
  const stale = (expected: string[], staleList: string[], ...paths: string[]) =>
    scoreQuery("fts", { ...query, expected, stale: staleList }, results(...paths), ks).current_first;

  test("true when the current path ranks above every stale one", () => {
    expect(stale(["now.md"], ["old.md"], "now.md", "old.md")).toBe(true);
  });

  test("false when a stale path ranks above it, or it is absent while a stale path is in the top k", () => {
    expect(stale(["now.md"], ["old.md"], "old.md", "now.md")).toBe(false);
    expect(stale(["now.md"], ["old.md"], "x.md", "old.md")).toBe(false);
  });

  test("true when no stale path is in the top max(k), wherever the current one is", () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}.md`);
    expect(stale(["now.md"], ["old.md"], ...deep, "old.md")).toBe(true);
    expect(stale(["now.md"], ["old.md"], "x.md")).toBe(true);
  });
});

describe("selectPaths", () => {
  const now = new Date("2026-07-12T00:00:00Z");
  const docs = [
    { path: "b.md", data: { title: "T", type: "project", deadline: new Date("2026-08-15T00:00:00Z") } },
    { path: "a.md", data: { title: "T", type: "project", deadline: "2026-08-15" } },
    { path: "c.md", data: { title: "T", type: "project", deadline: "2026-06-01" } },
    { path: "d.md", data: { title: "T", type: "note", deadline: "2026-09-01" } },
    { path: "e.md", data: { title: "T", type: "project", deadline: "someday" } },
    { path: "f.md", data: { title: "T", type: "project" } },
  ];

  test("after now, soonest first, ties by path; unreadable or missing dates are never selected", () => {
    expect(selectPaths({ field: "deadline", after: "now", order: "asc", take: 5 }, docs, now)).toEqual(["a.md", "b.md", "d.md"]);
  });

  test("type narrows, before bounds, desc reverses, take cuts", () => {
    expect(selectPaths({ type: "project", field: "deadline", after: "now", order: "asc", take: 5 }, docs, now)).toEqual(["a.md", "b.md"]);
    expect(selectPaths({ field: "deadline", before: "now", order: "desc", take: 5 }, docs, now)).toEqual(["c.md"]);
    expect(selectPaths({ field: "deadline", before: "2026-12-31", order: "desc", take: 2 }, docs, now)).toEqual(["d.md", "a.md"]);
  });

  test("the bound is strict: a date equal to now is not after it", () => {
    expect(selectPaths({ field: "deadline", after: "2026-08-15", order: "asc", take: 5 }, docs, now)).toEqual(["d.md"]);
  });
});

describe("impossible calendar dates", () => {
  test("isCalendarDate rejects a day that does not exist, and accepts one that does", () => {
    for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-07-32"]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
    for (const good of ["2028-02-29", "2026-12-31", "2026-07-12T09:00:00Z", "0050-01-01"]) {
      expect(isCalendarDate(good)).toBe(true);
    }
  });

  test("an impossible header now, --now value or selector bound is refused, not rolled over", () => {
    expect(() => parseEvalSet([line({ now: "2026-02-30" }), line(query)].join("\n"))).toThrow(/^line 1: header: now: /);
    expect(parseEvalDate("2026-04-31")).toBe(false);
    expect(parseEvalDate("2026-04-30")).toBe(true);
    const { expected: _drop, ...bare } = query;
    const select = { field: "deadline", after: "2026-02-29", order: "asc" as const, take: 1 };
    expect(() => parseEvalSet(line({ ...bare, expect: { select } }))).toThrow(/^line 1: /);
  });

  test("a document whose date does not exist is never selected, as written or as YAML rolled it", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const docs = [
      // gray-matter already turned `deadline: 2026-07-32` into August 1.
      { path: "rolled.md", data: { title: "R", type: "project", deadline: new Date("2026-08-01T00:00:00Z") }, raw: "title: R\ntype: project\ndeadline: 2026-07-32" },
      // Date.parse rolls this string to 2026-10-01, well after now.
      { path: "quoted.md", data: { title: "Q", type: "project", deadline: "2026-09-31" } },
      { path: "real.md", data: { title: "Real", type: "project", deadline: new Date("2026-08-15T00:00:00Z") }, raw: "deadline: 2026-08-15" },
    ];
    expect(selectPaths({ field: "deadline", after: "now", order: "asc", take: 3 }, docs, now)).toEqual(["real.md"]);
  });
});

describe("selectors see only indexable documents", () => {
  test("a document without title or type never takes a slot", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const docs = [
      { path: "draft.md", data: { deadline: "2026-07-20" } },
      { path: "untitled.md", data: { type: "project", deadline: "2026-07-21" } },
      { path: "status.md", data: { title: "Status", type: "project", deadline: "2026-08-15" } },
    ];
    expect(selectPaths({ field: "deadline", after: "now", order: "asc", take: 1 }, docs, now)).toEqual(["status.md"]);
  });
});
