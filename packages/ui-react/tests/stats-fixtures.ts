// The two /stats channels as the server sends them (#97), for Alex Example's
// brain on the fixture reference date. Every figure is chosen so that each
// health rung fires and each receipt row is non-empty; a test that needs a
// quieter brain overrides what it covers.
import type { ActivityRuntimeStats } from "@schlessera/brain-ui-sdk/protocol";
import type { CorpusStats } from "../src/lib/api-client.js";

const DAY = 86_400_000;
/** 22 Sep 2026, 12:00 UTC. */
export const NOW = Date.UTC(2026, 8, 22, 12);

export function corpusStats(over: Partial<CorpusStats> = {}): CorpusStats {
  return {
    documents: 412,
    byType: { concept: 142, person: 88, project: 61, meeting: 44, source: 31, recipe: 20, trip: 14, book: 8, talk: 4 },
    byStatus: { active: 301, draft: 88, archived: 23 },
    byRelevance: { high: 96, medium: 250, low: 66 },
    tags: 38,
    links: 1000,
    brokenLinks: 54,
    chunks: 3118,
    embeddings: 2557,
    health: {
      brokenLinkRate: 0.054,
      embeddingCoverage: 2557 / 3118,
      stale: 12,
      orphans: 4,
      untagged: 9,
      thresholds: { coverageFloor: 0.9, brokenLinkCeiling: 0.05 },
    },
    size: {
      corpus: { bytes: 22_231, files: 29 },
      db: { bytes: 453_208, tables: { documents: 412, links: 1000 }, vectorSlots: { live: 2557, allocated: 4096 } },
      freeBytes: 643_825_672_192,
    },
    ...over,
  };
}

export function runtimeStats(over: {
  window?: Partial<ActivityRuntimeStats["window"]>;
  lifetime?: Partial<ActivityRuntimeStats["lifetime"]>;
} = {}): ActivityRuntimeStats {
  return {
    generatedAt: NOW,
    lifetime: {
      scope: "lifetime",
      sessions: 61,
      turns: 1204,
      costUsd: 38.2,
      firstActivityAt: Date.UTC(2026, 1, 3, 9),
      lastActivityAt: NOW - 3_600_000,
      elapsedDays: 231,
      averages: { costUsdPerSession: 0.626, turnsPerSession: 19.7, costUsdPerDay: 0.165, costUsdPerMonth: 5.03 },
      ...over.lifetime,
    },
    window: {
      scope: "window",
      days: 30,
      since: NOW - 30 * DAY,
      until: NOW,
      recordedSince: Date.UTC(2026, 1, 3, 9),
      coveredDays: 30,
      detailRetention: { days: 14, cutoffAt: NOW - 14 * DAY, insideWindow: true },
      detailPrunedRuns: 38,
      runs: 142,
      failures: 3,
      costUsd: 11.2,
      effectiveCostUsd: 4.1,
      unpricedRuns: 3,
      unpricedListCostRuns: 5,
      inputTokens: 1_840_000,
      outputTokens: 212_000,
      cacheReadTokens: 6_100_000,
      cacheCreationTokens: 480_000,
      averages: {
        runsPerDay: 4.73,
        costUsdPerDay: null,
        costUsdPerMonth: null,
        effectiveCostUsdPerDay: null,
        effectiveCostUsdPerMonth: null,
      },
      ...over.window,
    },
    database: { sizeBytes: 1_258_291 },
  };
}

/** A server whose database has never seen a run. */
export function emptyRuntime(): ActivityRuntimeStats {
  return runtimeStats({
    lifetime: {
      sessions: 0,
      turns: 0,
      costUsd: 0,
      firstActivityAt: null,
      lastActivityAt: null,
      elapsedDays: 0,
      averages: { costUsdPerSession: null, turnsPerSession: null, costUsdPerDay: null, costUsdPerMonth: null },
    },
    window: {
      recordedSince: null,
      coveredDays: 0,
      detailRetention: { days: 14, cutoffAt: NOW - 14 * DAY, insideWindow: true },
      detailPrunedRuns: 0,
      runs: 0,
      failures: 0,
      costUsd: 0,
      effectiveCostUsd: 0,
      unpricedRuns: 0,
      unpricedListCostRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      averages: {
        runsPerDay: null,
        costUsdPerDay: null,
        costUsdPerMonth: null,
        effectiveCostUsdPerDay: null,
        effectiveCostUsdPerMonth: null,
      },
    },
  });
}
