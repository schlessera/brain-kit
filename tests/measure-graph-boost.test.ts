/**
 * The re-ranking step of `scripts/measure-graph-boost.ts` (#419): a boost
 * multiplies the scores of the boosted paths and re-sorts, keeping the
 * original order for ties, so the measured rank moves come from the boost and
 * nothing else.
 */

import { describe, expect, test } from "bun:test";

import { boost, goldenDrift, type Golden } from "../scripts/measure-graph-boost";
import type { QueryOutcome } from "../packages/core/src/lib/retrieval-eval";
import type { SearchResult } from "../packages/core/src/lib/types";

const result = (path: string, score: number): SearchResult =>
  ({ path, score, title: path, type: "note", relevance: "primary", status: "active", summary: null, tags: "", snippet: "" }) as SearchResult;

test("a boosted path overtakes one it trails by less than the factor, and not one it trails by more", () => {
  const results = [result("a.md", 10), result("b.md", 9), result("c.md", 5)];
  expect(boost(results, new Set(["b.md", "c.md"]), 1.25).map((r) => r.path)).toEqual(["b.md", "a.md", "c.md"]);
  expect(boost(results, new Set(["c.md"]), 1.5).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
});

test("an empty boost set, or a factor of 1, leaves the order as it was, ties included", () => {
  const results = [result("a.md", 3), result("b.md", 3), result("c.md", 1)];
  expect(boost(results, new Set(), 2).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
  expect(boost(results, new Set(["b.md"]), 1).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
});

test("each factor multiplies exactly the boosted scores", () => {
  const results = [result("a.md", 10), result("b.md", 8), result("c.md", 4)];
  for (const factor of [1.1, 1.25, 1.5, 2]) {
    const scores = Object.fromEntries(boost(results, new Set(["b.md", "c.md"]), factor).map((r) => [r.path, r.score]));
    expect(scores).toEqual({ "a.md": 10, "b.md": 8 * factor, "c.md": 4 * factor });
  }
});

/** A measured outcome with just the fields the golden check reads. */
const outcome = (id: string, rank: number | null, extra: Partial<QueryOutcome> = {}): QueryOutcome =>
  ({ mode: "fts", id, class: "c", q: id, expected: [], rank, hit_at: null, rr: null, top1_score: null, top: [], current_first: null, ...extra }) as QueryOutcome;

describe("goldenDrift, the measurement's baseline guard", () => {
  const baseline = [
    outcome("exact", 1),
    outcome("stale-facts", 1, { current_first: true }),
    outcome("no-answer-tax", null, { top: ["projects/active/bookshelf/status.md", "notes/x.md"] }),
  ];
  const goldens: Record<string, Golden> = {
    exact: { rank: 1 },
    "stale-facts": { rank: 1, current_first: true },
    "no-answer-tax": { rank: null, top: ["projects/active/bookshelf/status.md"] },
  };

  test("accepts a baseline that reproduces every pinned field", () => {
    expect(goldenDrift(baseline, goldens)).toEqual([]);
  });

  test("refuses a changed rank, current_first or top", () => {
    expect(goldenDrift(baseline, { ...goldens, exact: { rank: 2 } })).toEqual(["exact: rank 1 (golden 2)"]);
    expect(goldenDrift(baseline, { ...goldens, "stale-facts": { rank: 1, current_first: false } })).toEqual([
      "stale-facts: current_first true (golden false)",
    ]);
    expect(goldenDrift(baseline, { ...goldens, "no-answer-tax": { rank: null, top: ["me/identity.md"] } })).toEqual([
      'no-answer-tax: top ["projects/active/bookshelf/status.md"] (golden ["me/identity.md"])',
    ]);
  });

  test("refuses a query missing from either side", () => {
    const { exact: _dropped, ...fewer } = goldens;
    expect(goldenDrift(baseline, fewer)).toEqual(["exact: measured but has no golden"]);
    expect(goldenDrift(baseline, { ...goldens, extra: { rank: 1 } })).toEqual(["extra: in the goldens but not measured"]);
  });
});
