// The /stats answer as data (#97): which blocks, in what order, with which
// strings, for every state the design names. The drawing is covered by the
// render tests; these pin what the composer decides.
import { describe, expect, test } from "bun:test";

import {
  BAR_CAP,
  TREND_CAP,
  VALUE_BUDGET,
  composeStatsAnswer,
  cost,
  judgedPair,
  usd,
  type StatsSection,
} from "../src/components/chat/stats/compose-stats.js";
import { actionableTrends, corpusStats, emptyRuntime, runtimeStats, statsHistory } from "./stats-fixtures.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const failed = (error: string) => ({ ok: false as const, error });

type Of<K extends StatsSection["kind"]> = Extract<StatsSection, { kind: K }>;
const all = <K extends StatsSection["kind"]>(s: StatsSection[], kind: K) => s.filter((x): x is Of<K> => x.kind === kind);
const receipt = (s: StatsSection[], title: string) => {
  const found = all(s, "receipt").find((r) => r.title.startsWith(title));
  if (!found) throw new Error(`no receipt titled ${title}: ${all(s, "receipt").map((r) => r.title).join(", ")}`);
  return found;
};
const row = (r: Of<"receipt">, k: string) => {
  const found = r.rows.find((x) => x.k === k);
  if (!found) throw new Error(`no row ${k} in ${r.title}`);
  return found;
};
const text = (s: StatsSection[]) => JSON.stringify(s);

describe("core-owned actionable trends", () => {
  test("a current-value finding takes precedence and carries the same trend evidence in one callout", () => {
    const trends = actionableTrends();
    expect(trends.verdicts).toHaveLength(3);
    expect(trends.verdicts.every(v => v.state === "warning")).toBe(true);
    const c = corpusStats({ trends });
    const sections = composeStatsAnswer({ corpus: ok(c), runtime: ok(emptyRuntime()) });
    const callouts = all(sections, "callout").filter(v => v.tone !== "neutral");
    expect(callouts).toHaveLength(1);
    expect(callouts[0].title).toStartWith("Only 82.0%");
    expect(callouts[0].body).toContain(trends.verdicts[0].message);
    expect(callouts[0].body).toContain("2 more figures");
    for (const v of trends.verdicts) {
      const comparisons = all(sections, "receipt").filter(r => r.footnote === v.message);
      expect(comparisons).toHaveLength(1);
      expect(comparisons[0].rows.some(r => r.v === String(v.recent.median))).toBe(true);
      expect(comparisons[0].rows.every(r => r.v.length <= VALUE_BUDGET.plain)).toBe(true);
    }
  });

  test("an orphan warning comes from the supplied verdict even when current counts are low", () => {
    const trends = actionableTrends();
    trends.verdicts = trends.verdicts.filter(v => v.metric === "orphans");
    const c = corpusStats({ trends, health: { ...corpusStats().health, embeddingCoverage: 1, brokenLinkRate: 0, orphans: 0 } });
    const sections = composeStatsAnswer({ corpus: ok(c), runtime: ok(emptyRuntime()) });
    const callouts = all(sections, "callout").filter(v => v.tone === "gold");
    expect(callouts).toHaveLength(1);
    expect(callouts[0].body).toBe(trends.verdicts[0].message);
    expect(callouts[0].title).toContain("orphans");
  });

  test.each(["insufficient", "stale", "incomparable", "measured-no-warning"] as const)("state %s is never reclassified as a warning in the UI", state => {
    const trends = actionableTrends();
    for (const v of trends.verdicts) v.state = state;
    const c = corpusStats({ trends, health: { ...corpusStats().health, embeddingCoverage: 1, brokenLinkRate: 0 } });
    const sections = composeStatsAnswer({ corpus: ok(c), runtime: ok(emptyRuntime()) });
    expect(all(sections, "callout").filter(v => v.tone === "gold" || v.tone === "red")).toHaveLength(0);
    expect(all(sections, "receipt").filter(v => v.title.startsWith("Recorded "))).toHaveLength(state === "measured-no-warning" ? 3 : 0);
    expect(text(sections)).not.toContain('"title":"Healthy');
  });

  test("incomparable coverage is explained instead of connected as a like-for-like chart", () => {
    const history = statsHistory(3);
    const trends = actionableTrends();
    trends.verdicts = trends.verdicts.filter(v => v.metric === "embeddingCoverage");
    trends.verdicts[0].state = "incomparable";
    trends.verdicts[0].message = "Coverage definitions differ; recorded versions cannot establish comparability.";
    history.trends = trends;
    const sections = composeStatsAnswer({ corpus: ok(corpusStats()), runtime: ok(emptyRuntime()), history: ok(history) });
    expect(all(sections, "trend").some(v => v.label.startsWith("embedding coverage"))).toBe(false);
    const reason = receipt(sections, "Recorded embedding coverage");
    expect(row(reason, "comparison").v).toBe("incomparable");
    expect(reason.footnote).toBe(trends.verdicts[0].message);
    expect(reason.footTone).toBe("neutral");
    expect(all(sections, "trend").some(v => v.label.startsWith("documents"))).toBe(true);
  });
});

describe("the full answer", () => {
  const sections = composeStatsAnswer({ corpus: ok(corpusStats()), runtime: ok(runtimeStats()) });

  test("draws callout, two tile rows, breakdowns and receipts, in that order", () => {
    expect(sections.map((s) => s.kind)).toEqual([
      "callout",
      "tiles",
      "tiles",
      "bars",
      "bars",
      "bars",
      "receipt",
      "receipt",
      "receipt",
      "receipt",
    ]);
    const tiles = all(sections, "tiles");
    expect(tiles.map((t) => t.source)).toEqual(["corpus", "runtime"]);
    for (const t of tiles) expect(t.tiles).toHaveLength(2);
    expect(all(sections, "receipt").map((r) => r.title)).toEqual([
      "Corpus",
      "Runtime · 23 Aug – 22 Sep",
      "Since 3 Feb 2026",
      "On disk",
    ]);
  });

  test("renders the four fields the markdown answer dropped", () => {
    const corpus = receipt(sections, "Corpus");
    expect(row(corpus, "broken").v).toBe("54 · 5.4%");
    expect(row(corpus, "chunks").v).toBe("3,118");
    expect(row(corpus, "embeddings").v).toBe("2,557");
    const relevance = all(sections, "bars").find((b) => b.title === "By relevance")!;
    expect(relevance.rows.map((r) => [r.label, r.value])).toEqual([
      ["medium", "250"],
      ["high", "96"],
      ["low", "66"],
    ]);
  });

  test("the highest rung is the callout; it counts the others", () => {
    const callouts = all(sections, "callout");
    expect(callouts).toHaveLength(1);
    const [callout] = callouts;
    expect(callout.tone).toBe("red");
    expect(callout.title).toBe("Only 82.0% of eligible chunks have a vector, under the 90.0% floor.");
    // Chunk coverage, never a claim about notes.
    expect(callout.title + callout.body).not.toContain("notes");
    expect(callout.body).toEndWith("2 more figures are flagged below.");
  });

  test("the breakdown folds its tail into one row that keeps the total", () => {
    const types = all(sections, "bars").find((b) => b.title === "Documents by type")!;
    expect(types.rows).toHaveLength(BAR_CAP);
    expect(types.rows.at(-1)).toMatchObject({ label: "4 other types", value: "46", tone: "neutral" });
    const sum = types.rows.reduce((n, r) => n + Number(r.value.replace(/,/g, "")), 0);
    expect(sum).toBe(412);
    expect(types.meta).toBe("9 types");
    // A bar is its count's share of all documents, the remainder included.
    expect(types.rows[0].pct).toBeCloseTo((142 / 412) * 100, 6);
    expect(types.rows.at(-1)!.pct).toBeCloseTo((46 / 412) * 100, 6);
    const status = all(sections, "bars").find((b) => b.title === "By status")!;
    expect(status.rows.map((r) => Math.round(r.pct))).toEqual([73, 21, 6]);
  });

  test("the two unpriced counters stay apart, and the sums read as floors", () => {
    const runtime = receipt(sections, "Runtime");
    expect(row(runtime, "paid").v).toBe("≥ $4.10");
    expect(row(runtime, "list price").v).toBe("≥ $11.20");
    expect(row(runtime, "unpriced").v).toBe("3 paid · 5 list");
    // The server withheld the rate; it is not recomputed here.
    expect(row(runtime, "per month").v).toBe("not computed");
  });

  test("retention is said once, in the window's footnote, with its count", () => {
    const runtime = receipt(sections, "Runtime");
    expect(runtime.footnote).toBe("per-run detail is kept 14 days · 38 of these 142 runs are totals only");
    expect(runtime.footTone).toBe("gold");
    const labels = all(sections, "tiles")[1].tiles.map((t) => t.label);
    expect(labels).toEqual(["runs · 30d", "spent · 30d"]);
  });

  test("lifetime costs are floors and never sit in the window receipt", () => {
    const lifetime = receipt(sections, "Since");
    expect(row(lifetime, "cost").v).toBe("≥ $38.20");
    expect(row(lifetime, "per session").v).toBe("≥ $0.63");
    expect(lifetime.footnote).toContain("floor");
    expect(receipt(sections, "Runtime").rows.map((r) => r.k)).not.toContain("sessions");
  });

  test("the disk footnote claims only the index is rebuildable", () => {
    const disk = receipt(sections, "On disk");
    expect(disk.rows.map((r) => r.k)).toEqual(["notes", "index", "server db", "free"]);
    expect(disk.footnote).toBe("markdown is the source · the search index is rebuildable");
    expect(disk.footnote).not.toContain("server");
  });
});

describe("health thresholds", () => {
  test("the coverage warning names its eligible denominator, not the total chunk inventory", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats({ chunks: 999, embeddings: 50,
        health: { ...corpusStats().health, brokenLinkRate: 0, embeddingCoverage: 0.5 } })),
      runtime: ok(runtimeStats({ window: { failures: 0 } })),
    });
    const [callout] = all(sections, "callout");
    expect(callout.title).toBe("Only 50.0% of eligible chunks have a vector, under the 90.0% floor.");
    expect(row(receipt(sections, "Corpus"), "chunks").v).toBe("999");
  });

  test("no callout when nothing crosses a threshold", () => {
    const quiet = corpusStats({
      brokenLinks: 3,
      embeddings: 3000,
      health: { ...corpusStats().health, brokenLinkRate: 0.003, embeddingCoverage: 0.962 },
    });
    const sections = composeStatsAnswer({ corpus: ok(quiet), runtime: ok(runtimeStats({ window: { failures: 0 } })) });
    expect(all(sections, "callout")).toEqual([]);
    expect(all(sections, "tiles")[0].tiles[1].tone).toBeUndefined();
  });

  test("broken links over the ceiling fire alone, and the tile carries the tone", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats({ health: { ...corpusStats().health, embeddingCoverage: 0.95 } })),
      runtime: ok(runtimeStats({ window: { failures: 0 } })),
    });
    const [callout] = all(sections, "callout");
    expect(callout).toMatchObject({ tone: "gold", title: "54 links point at notes that don't exist." });
    expect(callout.body).toStartWith("That is 5.4% of all links, over the 5.0% ceiling.");
    // `brain validate` is the command that reports unresolved wiki-links.
    expect(callout.body).toContain("`brain validate`");
    expect(callout.body).not.toContain("flagged below");
    expect(all(sections, "tiles")[0].tiles[1].tone).toBe("gold");
  });

  test("a ratio that rounds onto its threshold widens until the two differ", () => {
    expect(judgedPair(0.0504, 0.05)).toEqual({ ratio: "5.04%", threshold: "5.00%" });
    expect(judgedPair(0.05, 0.05)).toEqual({ ratio: "5.0%", threshold: "5.0%" });
    // Closer than any sensible precision: the side is said, not two equal numbers.
    expect(judgedPair(0.05000000001, 0.05)).toEqual({ ratio: "just over 5.0%", threshold: "5.0%" });
    expect(judgedPair(0.9, 0.90000000001)).toEqual({ ratio: "just under 90.0%", threshold: "90.0%" });
  });
});

describe("unknown is never $0", () => {
  test("every run unpriced reads unknown, in the tile and the receipt", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats()),
      runtime: ok(runtimeStats({ window: { unpricedRuns: 142, unpricedListCostRuns: 142, effectiveCostUsd: 0, costUsd: 0 } })),
    });
    const spent = all(sections, "tiles")[1].tiles[1];
    expect(spent).toMatchObject({ value: "unknown", tone: "dim", meta: "142 of 142 unpriced" });
    expect(row(receipt(sections, "Runtime"), "paid").v).toBe("unknown");
    expect(row(receipt(sections, "Runtime"), "list price").v).toBe("unknown");
    expect(text(sections)).not.toContain('"$0.00"');
  });

  test("a subscription window: paid is a known $0, list price unknown", () => {
    expect(cost(0, 0, 10)).toBe("$0.00");
    expect(cost(0, 10, 10)).toBe("unknown");
    expect(cost(1.5, 2, 10)).toBe("≥ $1.50");
    // A known part under a cent, with unpriced runs beside it.
    expect(cost(0.000_04, 1, 2)).toBe("> $0.00");
  });

  test("a real cost under a cent does not round to free", () => {
    expect(usd(0.000_04)).toBe("< $0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd(1234.5)).toBe("$1,234.50");
  });
});

describe("unavailable and empty states", () => {
  test("runtime down: the corpus renders in full, the runtime half says why", () => {
    const sections = composeStatsAnswer({ corpus: ok(corpusStats()), runtime: failed("timeout") });
    const unavailable = all(sections, "callout").find((c) => c.title === "Runtime figures unavailable.")!;
    expect(unavailable.tone).toBe("neutral");
    expect(unavailable.body).toContain("timeout");
    expect(all(sections, "tiles").map((t) => t.source)).toEqual(["corpus"]);
    expect(receipt(sections, "Corpus").rows).toHaveLength(9);
    expect(row(receipt(sections, "On disk"), "server db").v).toBe("unavailable");
    expect(all(sections, "receipt").map((r) => r.title)).not.toContain("Since 3 Feb 2026");
    expect(text(sections)).not.toMatch(/NaN|Infinity|"\$0\.00"/);
  });

  test("corpus down: the runtime renders, the corpus half says why", () => {
    const sections = composeStatsAnswer({ corpus: failed("no brain.db"), runtime: ok(runtimeStats()) });
    expect(all(sections, "callout").map((c) => c.title)).toContain("Corpus figures unavailable.");
    expect(all(sections, "tiles").map((t) => t.source)).toEqual(["runtime"]);
    expect(all(sections, "bars")).toEqual([]);
    expect(receipt(sections, "On disk").rows.map((r) => r.k)).toEqual(["server db"]);
  });

  test("no run ever recorded: one plain notice, no runtime receipts, no $0", () => {
    const sections = composeStatsAnswer({ corpus: ok(corpusStats()), runtime: ok(emptyRuntime()) });
    expect(all(sections, "callout").map((c) => c.title)).toContain("No agent runs recorded yet.");
    expect(all(sections, "tiles").map((t) => t.source)).toEqual(["corpus"]);
    const titles = all(sections, "receipt").map((r) => r.title);
    expect(titles).toEqual(["Corpus", "On disk"]);
    expect(text(sections)).not.toContain("$0");
  });

  test("no run in this window but some before: zero runs, a dash for cost", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats()),
      runtime: ok(runtimeStats({ window: { runs: 0, failures: 0, unpricedRuns: 0, unpricedListCostRuns: 0, costUsd: 0, effectiveCostUsd: 0 } })),
    });
    const [runs, spent] = all(sections, "tiles")[1].tiles;
    expect(runs.value).toBe("0");
    expect(spent).toMatchObject({ value: "—", tone: "dim" });
    expect(runs.meta).toBe("none in this window");
    expect(all(sections, "receipt").map((r) => r.title)).toEqual(["Corpus", "Since 3 Feb 2026", "On disk"]);
  });

  test("a record shorter than the window says how much it covers", () => {
    const since = Date.UTC(2026, 8, 10, 12);
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats()),
      runtime: ok(runtimeStats({ window: { recordedSince: since, coveredDays: 12 } })),
    });
    expect(all(sections, "tiles")[1].tiles[0].label).toBe("runs · 12d");
    const runtime = receipt(sections, "Runtime");
    expect(runtime.title).toBe("Runtime · 10 Sep – 22 Sep");
    expect(row(runtime, "covers").v).toBe("12 of 30 days");
  });

  test("null coverage reads not measured, never not configured", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats({ embeddings: null, health: { ...corpusStats().health, embeddingCoverage: null } })),
      runtime: ok(runtimeStats()),
    });
    const corpus = receipt(sections, "Corpus");
    expect(row(corpus, "coverage").v).toBe("not measured");
    expect(row(corpus, "embeddings").v).toBe("not counted");
    expect(text(sections)).not.toMatch(/not configured|keyword search/);
  });

  test("an empty brain: one notice in place of the corpus blocks", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats({ documents: 0, byType: {}, byStatus: {}, byRelevance: {}, links: 0, brokenLinks: 0, health: { ...corpusStats().health, brokenLinkRate: null, embeddingCoverage: null } })),
      runtime: ok(runtimeStats()),
    });
    expect(all(sections, "callout").map((c) => c.title)).toContain("This brain has no notes yet.");
    expect(all(sections, "bars")).toEqual([]);
    expect(all(sections, "receipt").map((r) => r.title)).not.toContain("Corpus");
  });
});

describe("the row budget", () => {
  /**
   * Every row at the largest figures a real brain and server plausibly
   * reach. A value past the budget would break mid-number at 320px; that is
   * a composition bug, and it fails here rather than shipping.
   */
  test("every receipt value fits its budget at maximum-size figures", () => {
    const big = corpusStats({
      tags: 99_999,
      links: 999_999,
      brokenLinks: 120_000,
      chunks: 9_999_999,
      embeddings: 9_999_999,
      health: { ...corpusStats().health, brokenLinkRate: 0.12, embeddingCoverage: 0.5, stale: 99_999, orphans: 99_999, untagged: 99_999 },
      size: {
        corpus: { bytes: 999.9 * 1024 ** 3, files: 123_456 },
        db: { bytes: 999.9 * 1024 ** 3, tables: {}, vectorSlots: { live: null, allocated: null } },
        freeBytes: 999.9 * 1024 ** 4,
      },
    });
    const bigRuntime = runtimeStats({
      window: {
        runs: 99_999,
        failures: 99_999,
        costUsd: 99_999.99,
        effectiveCostUsd: 99_999.99,
        unpricedRuns: 9_999,
        unpricedListCostRuns: 9_999,
        inputTokens: 999_000_000_000,
        outputTokens: 999_000_000_000,
        cacheReadTokens: 999_000_000_000,
        cacheCreationTokens: 999_000_000_000,
        averages: { runsPerDay: 9999.9, costUsdPerDay: null, costUsdPerMonth: null, effectiveCostUsdPerDay: 9999, effectiveCostUsdPerMonth: 99_999.99 },
      },
      lifetime: { sessions: 999_999, turns: 9_999_999, costUsd: 999_999.99, averages: { costUsdPerSession: 99_999.99, turnsPerSession: 9999.9, costUsdPerDay: 9999, costUsdPerMonth: 99_999.99 } },
    });
    const sections = composeStatsAnswer({ corpus: ok(big), runtime: ok(bigRuntime) });
    const rows = all(sections, "receipt").flatMap((r) => r.rows);
    expect(rows.length).toBeGreaterThan(25);
    // Only these tones draw a cue glyph before the value (`VALUE_CUE`).
    const cued = new Set(["red", "gold", "amber", "purple"]);
    const over = rows.filter((r) => [...r.v].length > (cued.has(r.tone ?? "") ? VALUE_BUDGET.toned : VALUE_BUDGET.plain));
    expect(over).toEqual([]);
  });
});

describe("an activity record with no runs, beside sessions that exist", () => {
  test("the runs tile says none are on record, not none in the window", () => {
    const sections = composeStatsAnswer({
      corpus: ok(corpusStats()),
      runtime: ok(runtimeStats({ window: { recordedSince: null, coveredDays: 0, runs: 0, failures: 0, unpricedRuns: 0, unpricedListCostRuns: 0 } })),
    });
    expect(all(sections, "tiles")[1].tiles[0]).toMatchObject({ value: "0", meta: "none on record" });
  });
});

describe("trends from the recorded history (#581)", () => {
  const compose = (history?: Parameters<typeof composeStatsAnswer>[0]["history"]) =>
    composeStatsAnswer({ corpus: ok(corpusStats()), runtime: ok(runtimeStats()), history });

  test("two snapshots draw the five trends, after the corpus receipt", () => {
    const sections = compose(ok(statsHistory(3)));
    const trends = all(sections, "trend");
    expect(trends.map((t) => t.label)).toEqual([
      "documents · 3 snapshots",
      "orphans · 3 snapshots",
      "stale · 3 snapshots",
      "embedding coverage · 2 snapshots",
      "broken-link rate · 3 snapshots",
    ]);
    const kinds = sections.map((s) => s.kind);
    expect(kinds.indexOf("trend")).toBe(sections.indexOf(receipt(sections, "Corpus")) + 1);
    const documents = trends[0];
    expect(documents.values).toEqual([400, 401, 402]);
    expect(documents.value).toBe("402");
    expect(documents.ticks).toEqual(["20 Sep", "", "22 Sep"]);
  });

  test("a null in a series is left out, never drawn as 0", () => {
    const coverage = all(compose(ok(statsHistory(3))), "trend").find((t) => t.label.startsWith("embedding coverage"));
    expect(coverage?.values).toEqual([0.81, 0.82]);
    expect(coverage?.value).toBe("82.0%");
    expect(coverage?.ticks).toEqual(["21 Sep", "22 Sep"]);
  });

  test(`at most ${TREND_CAP} snapshots, the latest ones`, () => {
    const trends = all(compose(ok(statsHistory(40))), "trend");
    expect(trends).toHaveLength(5);
    for (const t of trends) {
      expect(t.values).toHaveLength(TREND_CAP);
      expect(t.ticks).toHaveLength(TREND_CAP);
    }
    expect(trends[0].values.at(-1)).toBe(439);
  });

  test("fewer than two snapshots draw nothing: no chart, no placeholder", () => {
    const one = compose(ok(statsHistory(1)));
    const none = compose(ok(statsHistory(0)));
    const without = compose();
    // The guard is real: the same composer draws trends from two.
    expect(all(compose(ok(statsHistory(2))), "trend")).toHaveLength(4);
    for (const sections of [one, none, without, compose(failed("404"))]) {
      expect(all(sections, "trend")).toEqual([]);
      expect(sections.map((s) => s.kind)).toEqual(without.map((s) => s.kind));
      expect(text(sections)).not.toContain("snapshot");
    }
  });

  test("a series an older CLI never reported is skipped, not drawn empty", () => {
    const h = statsHistory(3);
    const partial = { dates: h.dates, documents: h.documents } as unknown as typeof h;
    expect(all(compose(ok(partial)), "trend").map((t) => t.label)).toEqual(["documents · 3 snapshots"]);
  });
});
