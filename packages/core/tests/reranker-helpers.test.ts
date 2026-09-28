/**
 * The helpers that run any Reranker safely — in hybridSearch and in a search
 * that fans out over several sources: path exclusion, placement of withheld
 * candidates, permutation validation, and the mode vocabulary.
 */
import { describe, expect, test } from "bun:test";

import {
  assertPermutation,
  buildPathMatcher,
  candidateKey,
  isRerankMode,
  mergeWithheld,
  partitionForRerank,
  RERANK_MODES,
} from "../src/lib/reranker";
import type { RerankCandidate } from "../src/lib/seams";

function candidate(overrides: Partial<RerankCandidate> & { id: string }): RerankCandidate {
  return { title: overrides.id, score: 1, ...overrides };
}

describe("rerank modes", () => {
  test("none, heuristic and jev, nothing else", () => {
    expect(RERANK_MODES).toEqual(["none", "heuristic", "jev"]);
    expect(isRerankMode("jev")).toBe(true);
    expect(isRerankMode("title")).toBe(false);
    expect(isRerankMode(undefined)).toBe(false);
  });
});

describe("buildPathMatcher", () => {
  test("no patterns → no matcher", () => {
    expect(buildPathMatcher(undefined)).toBeUndefined();
    expect(buildPathMatcher([])).toBeUndefined();
  });

  test("a bare name is a directory or file prefix, not a substring", () => {
    const m = buildPathMatcher(["career", "private/"])!;
    expect(m("career/opportunities/x.md")).toBe(true);
    expect(m("career")).toBe(true);
    expect(m("careers/x.md")).toBe(false);
    expect(m("private/eval/run.ts")).toBe(true);
    expect(m("notes/x.md")).toBe(false);
  });

  test("glob patterns match the whole path", () => {
    const m = buildPathMatcher(["clients/**/ledger.md", "*.pdf"])!;
    expect(m("clients/acme/ledger.md")).toBe(true);
    expect(m("clients/acme/profile.md")).toBe(false);
    expect(m("cv.pdf")).toBe(true);
    expect(m("me/cv.pdf")).toBe(false);
  });
});

describe("withheld candidates", () => {
  const pool = ["a", "b", "c", "d", "e"].map((id) => candidate({ id }));

  test("partition keeps retrieval indices for withheld candidates", () => {
    const { sendable, withheld } = partitionForRerank(pool, (c) => c.id === "b" || c.id === "d");
    expect(sendable.map((c) => c.id)).toEqual(["a", "c", "e"]);
    expect([...withheld.keys()]).toEqual([1, 3]);
  });

  test("merge places withheld candidates at their retrieval rank and fills the rest in reranked order", () => {
    const { sendable, withheld } = partitionForRerank(pool, (c) => c.id === "b" || c.id === "d");
    const reranked = [sendable[2], sendable[0], sendable[1]]; // e, a, c
    const merged = mergeWithheld(reranked, withheld, pool.length);
    expect(merged.map((c) => c.id)).toEqual(["e", "b", "a", "d", "c"]);
  });

  test("no exclusion → everything is sendable and merge is the reranked order", () => {
    const { sendable, withheld } = partitionForRerank(pool, undefined);
    expect(sendable).toHaveLength(5);
    expect(withheld.size).toBe(0);
    expect(mergeWithheld([...sendable].reverse(), withheld, 5).map((c) => c.id)).toEqual(["e", "d", "c", "b", "a"]);
  });
});

describe("assertPermutation", () => {
  const input = [candidate({ id: "a" }), candidate({ id: "b", source: "calendar" })];

  test("accepts a reordering", () => {
    expect(() => assertPermutation(input, [{ item: input[1], score: 0.9 }, { item: input[0], score: 0.1 }])).not.toThrow();
  });

  test("rejects a dropped candidate", () => {
    expect(() => assertPermutation(input, [{ item: input[0], score: 1 }])).toThrow(/1 of 2/);
  });

  test("rejects duplicates and strangers", () => {
    expect(() => assertPermutation(input, [{ item: input[0], score: 1 }, { item: input[0], score: 1 }])).toThrow(/duplicate/);
    expect(() => assertPermutation(input, [{ item: input[0], score: 1 }, { item: candidate({ id: "zzz" }), score: 1 }])).toThrow(/not one it was given/);
  });

  test("identity is source + id, so the same id from two sources is two candidates", () => {
    const a = candidate({ id: "x", source: "brain" });
    const b = candidate({ id: "x", source: "calendar" });
    expect(candidateKey(a)).toBe("brain:x");
    expect(candidateKey(b)).toBe("calendar:x");
    expect(() => assertPermutation([a, b], [{ item: b, score: 1 }, { item: a, score: 0 }])).not.toThrow();
  });

  test("rejects an equal copy: the caller's objects must come back by reference", () => {
    const copy = { ...input[0] };
    expect(() => assertPermutation(input, [{ item: copy, score: 1 }, { item: input[1], score: 0 }])).toThrow(/not one it was given/);
  });

  test("rejects non-finite scores", () => {
    expect(() => assertPermutation(input, [{ item: input[0], score: NaN }, { item: input[1], score: 1 }])).toThrow(/non-finite/);
  });
});
