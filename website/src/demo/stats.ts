// `brain stats` for the demo brain, measured from the same files the file tree,
// search and graph serve. Nothing here is a typed-in figure about the corpus:
// counts, rates and the daily history are computed from the records and their
// dates. The runtime half (sessions, runs, spend) is fiction about a fictional
// agent, kept small and stated once.
import type { ActivityRuntimeStats } from '../../../packages/ui-sdk/src/protocol.ts';
import type { CorpusStats, CorpusStatsHistory } from '../../../packages/ui-react/src/lib/api-client.ts';
import { binaryDocuments, demoDocuments } from './corpus.ts';
import { indexed } from './knowledge.ts';
import { referenceNow } from './odyssey.ts';

const DAY = 86_400_000;
const STALE_DAYS = 180; // core's default per-type window (`DEFAULT_STALENESS`)
const THRESHOLDS = { coverageFloor: 0.9, brokenLinkCeiling: 0.05 }; // core's `DEFAULT_STATS_THRESHOLDS`
// A capture made in the last two days has not been embedded yet: the
// embedding queue runs behind the writes, as it does on a real host.
const EMBED_LAG_DAYS = 2;
const CHUNK_CHARS = 1_200;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const { records, idOf, outgoing, brokenLinks, tagsOf, createdOf, typeOf, statusOf, body } = indexed;
const chunksOf = (record: (typeof records)[number]) => Math.max(1, Math.ceil(body(record).length / CHUNK_CHARS));

/** The corpus as it stood at the end of `date`: only records created by then. */
function measure(date: string) {
  const present = records.filter(record => createdOf(record) <= date);
  const ids = new Set(present.map(record => idOf.get(record.path)!));
  const linked = new Set<number>(); let links = 0;
  for (const id of ids) for (const target of outgoing.get(id)!) if (ids.has(target)) { links++; linked.add(id); linked.add(target); }
  const sources = new Set(present.map(record => record.path));
  const broken = brokenLinks.filter(link => sources.has(link.sourcePath)).length;
  const end = Date.parse(`${date}T23:59:59Z`);
  const chunks = present.reduce((sum, record) => sum + chunksOf(record), 0);
  const embedded = present.filter(record => end - Date.parse(`${createdOf(record)}T00:00:00Z`) > EMBED_LAG_DAYS * DAY).reduce((sum, record) => sum + chunksOf(record), 0);
  return {
    present, links: links + broken, broken, chunks, embedded,
    orphans: present.filter(record => !linked.has(idOf.get(record.path)!)).length,
    stale: present.filter(record => (end - Date.parse(`${record.updated}T00:00:00Z`)) / DAY > STALE_DAYS).length,
    untagged: present.filter(record => tagsOf(record).length === 0).length,
  };
}

function count<T>(items: T[], key: (item: T) => string | undefined) {
  const out: Record<string, number> = {};
  for (const item of items) { const k = key(item); if (k) out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function corpusStats(): CorpusStats {
  const today = measure(iso(referenceNow));
  const bytes = demoDocuments.reduce((sum, record) => sum + new TextEncoder().encode(record.content).length, 0);
  return {
    documents: today.present.length,
    byType: count(today.present, typeOf),
    byStatus: count(today.present, statusOf),
    byRelevance: {},
    tags: new Set(today.present.flatMap(tagsOf).map(tag => tag.toLowerCase())).size,
    links: today.links, brokenLinks: today.broken, chunks: today.chunks, embeddings: today.embedded,
    health: {
      brokenLinkRate: today.links ? today.broken / today.links : null,
      embeddingCoverage: today.chunks ? today.embedded / today.chunks : null,
      stale: today.stale, orphans: today.orphans, untagged: today.untagged, thresholds: THRESHOLDS,
    },
    size: {
      corpus: { bytes, files: demoDocuments.length + binaryDocuments.length },
      // brain.db is disposable; its weight here is the shape a real index of
      // these files takes, row counts exact, bytes scaled from them.
      db: { bytes: 4_096 * (64 + today.present.length * 3 + today.chunks * 2), tables: { documents: today.present.length, links: today.links, chunks: today.chunks, tags: new Set(today.present.flatMap(tagsOf)).size }, vectorSlots: { live: today.embedded, allocated: Math.ceil(today.embedded / 1024) * 1024 } },
      freeBytes: 41_212_928_000,
    },
  };
}

/** One snapshot a day for the last six weeks, oldest first, as `brain stats --history` keeps them. */
export function corpusStatsHistory(): CorpusStatsHistory {
  const dates = Array.from({ length: 42 }, (_, i) => iso(referenceNow - (41 - i) * DAY));
  const days = dates.map(measure);
  return {
    dates,
    documents: days.map(day => day.present.length),
    health: {
      brokenLinkRate: days.map(day => (day.links ? day.broken / day.links : null)),
      embeddingCoverage: days.map(day => (day.chunks ? day.embedded / day.chunks : null)),
      stale: days.map(day => day.stale), orphans: days.map(day => day.orphans), untagged: days.map(day => day.untagged),
    },
  };
}

/** The agent's own record: a quiet month of digests and reviews, no host behind it. */
export function activityStats(days = 30): ActivityRuntimeStats {
  const window = Math.min(90, Math.max(1, days));
  const runs = Math.round(window * 3.2), cost = +(window * 0.71).toFixed(2), first = Date.parse('2019-07-20T06:40:00+02:00');
  const elapsedDays = Math.floor((referenceNow - first) / DAY);
  return {
    generatedAt: referenceNow,
    lifetime: { scope: 'lifetime', sessions: 312, turns: 2_148, costUsd: 418.62, firstActivityAt: first, lastActivityAt: referenceNow, elapsedDays, averages: { costUsdPerSession: +(418.62 / 312).toFixed(4), turnsPerSession: +(2_148 / 312).toFixed(2), costUsdPerDay: +(418.62 / elapsedDays).toFixed(4), costUsdPerMonth: +((418.62 / elapsedDays) * 365.25 / 12).toFixed(2) } },
    window: { scope: 'window', days: window, since: referenceNow - window * DAY, until: referenceNow, recordedSince: first, coveredDays: window, detailRetention: { days: 30, cutoffAt: referenceNow - 30 * DAY, insideWindow: window <= 30 }, detailPrunedRuns: Math.max(0, runs - 96), runs, failures: Math.round(runs / 24), costUsd: cost, effectiveCostUsd: cost, unpricedRuns: 0, unpricedListCostRuns: 0, inputTokens: runs * 18_400, outputTokens: runs * 1_350, cacheReadTokens: runs * 61_000, cacheCreationTokens: runs * 7_800, averages: { runsPerDay: +(runs / window).toFixed(2), costUsdPerDay: +(cost / window).toFixed(4), costUsdPerMonth: +((cost / window) * 365.25 / 12).toFixed(2), effectiveCostUsdPerDay: +(cost / window).toFixed(4), effectiveCostUsdPerMonth: +((cost / window) * 365.25 / 12).toFixed(2) } },
    database: { sizeBytes: 2_621_440 },
  };
}
