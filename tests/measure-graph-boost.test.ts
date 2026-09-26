/**
 * The re-ranking step of `scripts/measure-graph-boost.ts` (#419): a boost
 * multiplies the scores of the boosted paths and re-sorts, keeping the
 * original order for ties, so the measured rank moves come from the boost and
 * nothing else.
 */

import { expect, test } from "bun:test";

import { boost } from "../scripts/measure-graph-boost";
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
