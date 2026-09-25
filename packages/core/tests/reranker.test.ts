import { describe, expect, setSystemTime, test } from "bun:test";

import { recencyFactor, rerank } from "../src/lib/reranker";
import type { SearchResult } from "../src/lib/types";

const DAY = 86_400_000;

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    path: "x.md",
    title: "X",
    type: "note",
    relevance: "secondary",
    status: "active",
    summary: null,
    tags: "",
    score: 1,
    snippet: "",
    ...overrides,
  };
}

describe("recencyFactor", () => {
  const now = new Date("2026-06-11").getTime();

  test("fresh document gets full credit", () => {
    expect(recencyFactor("context", "2026-06-11", now)).toBeCloseTo(1, 2);
  });

  test("context decays to half-credit-above-floor after 30 days", () => {
    const factor = recencyFactor("context", new Date(now - 30 * DAY).toISOString(), now);
    // floor 0.7 + 0.3 * 0.5
    expect(factor).toBeCloseTo(0.85, 2);
  });

  test("durable types decay slower than volatile types", () => {
    const old = new Date(now - 180 * DAY).toISOString();
    expect(recencyFactor("identity", old, now)).toBeGreaterThan(recencyFactor("context", old, now));
  });

  test("never decays below the floor", () => {
    expect(recencyFactor("context", "2000-01-01", now)).toBeGreaterThanOrEqual(0.7);
  });

  test("missing or invalid dates are neutral", () => {
    expect(recencyFactor("context", undefined, now)).toBe(1);
    expect(recencyFactor("context", "not-a-date", now)).toBe(1);
  });
});

describe("rerank", () => {
  test("primary relevance outranks historical at equal base score", () => {
    const candidates = [
      result({ path: "old.md", relevance: "historical", updated: "2026-06-01" }),
      result({ path: "new.md", relevance: "primary", updated: "2026-06-01" }),
    ];
    const ranked = rerank("query", candidates, { mode: "heuristic" });
    expect(ranked[0].path).toBe("new.md");
  });

  test("title match outranks non-match at equal base score", () => {
    const candidates = [
      result({ path: "a.md", title: "Unrelated", updated: "2026-06-01" }),
      result({ path: "b.md", title: "Agentic Engineering", updated: "2026-06-01" }),
    ];
    const ranked = rerank("agentic engineering", candidates, { mode: "heuristic" });
    expect(ranked[0].path).toBe("b.md");
  });

  test("mode none preserves order", () => {
    const candidates = [
      result({ path: "first.md", relevance: "historical" }),
      result({ path: "second.md", relevance: "primary" }),
    ];
    const ranked = rerank("query", candidates, { mode: "none" });
    expect(ranked[0].path).toBe("first.md");
  });
});

describe("rerank with a pinned now", () => {
  // Higher base score, older, fast-decaying type vs. lower base score,
  // newer, slow-decaying type: the order flips as the clock moves on.
  const candidates = () => [
    result({ path: "context.md", type: "context", updated: "2026-07-11", score: 1.12 }),
    result({ path: "identity.md", type: "identity", updated: "2026-07-12", score: 1 }),
  ];

  test("recency is measured from config.now", () => {
    // Freeze the ambient clock on the first date, so a rerank that ignored
    // `now` would pass the first assertion and fail on the second.
    setSystemTime(new Date("2026-07-12"));
    try {
      const fresh = rerank("query", candidates(), { mode: "heuristic", now: new Date("2026-07-12") });
      expect(fresh.map((r) => r.path)).toEqual(["context.md", "identity.md"]);
      const later = rerank("query", candidates(), { mode: "heuristic", now: new Date("2028-07-12") });
      expect(later.map((r) => r.path)).toEqual(["identity.md", "context.md"]);
    } finally {
      setSystemTime();
    }
  });

  test("an invalid now throws", () => {
    expect(() => rerank("query", candidates(), { mode: "heuristic", now: new Date("nope") })).toThrow(
      "now must be a valid Date"
    );
  });
});
