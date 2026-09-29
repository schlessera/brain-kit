/**
 * The brain's stats over time (#581): one compact snapshot of `BrainStats` per
 * day, kept in a JSONL file at the brain root.
 *
 * The file is committed with the brain, not kept in `brain.db` (which a
 * rebuild erases) and not under `.brain/` (which a fresh clone loses). One
 * machine records — the one running `brain maintain` on a schedule — and the
 * file is rewritten sorted by date, one line per day, so a merge of two
 * clones' histories stays line-local.
 *
 * Retention: every day for the last `DAILY_DAYS`, then one snapshot per ISO
 * week (the latest recorded in it). Thinning is idempotent: an entry it keeps
 * stays kept as the window moves, because the week's latest entry never
 * changes once the whole week is past the cutoff.
 *
 * Nothing is indexed from this file. The indexer globs markdown and assets
 * only, and every other walk skips dotfiles, so it is outside indexing,
 * validation and audit by construction.
 */
import { existsSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { writeFileSafely } from "./safe-path.js";
import type { BrainStats } from "./stats.js";

export const STATS_HISTORY_FILE = ".stats-history.jsonl";

/** Days kept at one snapshot per day before thinning to one per week. */
export const DAILY_DAYS = 90;

/**
 * What one day keeps of `BrainStats`: the counts, the health figures and the
 * size totals. The thresholds are configuration, not a measurement, and are
 * left out; `size.db.tables` is reduced to its total row count.
 */
export interface StatsSnapshot {
  /** `YYYY-MM-DD`, UTC. The day this snapshot stands for; one per day. */
  date: string;
  /** ISO timestamp of the recording. */
  at: string;
  /** The brain-kit version that recorded it. */
  version: string;
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRelevance: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
  embeddings: number | null;
  health: {
    brokenLinkRate: number | null;
    embeddingCoverage: number | null;
    stale: number;
    orphans: number;
    untagged: number;
  };
  size: {
    corpusBytes: number | null;
    corpusFiles: number | null;
    dbBytes: number | null;
    dbRows: number;
    vectorsLive: number | null;
    vectorsAllocated: number | null;
    freeBytes: number | null;
  };
}

/** The flat numeric fields of a snapshot, in output order. */
const COUNTS = ["documents", "tags", "links", "brokenLinks", "chunks", "embeddings"] as const;
const BREAKDOWNS = ["byType", "byStatus", "byRelevance"] as const;
const HEALTH = ["brokenLinkRate", "embeddingCoverage", "stale", "orphans", "untagged"] as const;
const SIZE = ["corpusBytes", "corpusFiles", "dbBytes", "dbRows", "vectorsLive", "vectorsAllocated", "freeBytes"] as const;

type Series = (number | null)[];

/**
 * `brain stats --history --json`: the snapshots, oldest first, as one array
 * per field — each index is one snapshot, so `dates[i]` names `documents[i]`.
 * A field the recording version did not have reads `null`, never `0`. In a
 * breakdown, a key missing from a snapshot that does carry the breakdown is a
 * real `0` (no document had that type then); a snapshot without the
 * breakdown at all reads `null` for every key.
 */
export interface StatsHistory {
  dates: string[];
  /** When each snapshot was recorded; null for a line without one. */
  recordedAt: (string | null)[];
  /** The brain-kit version that recorded each; null for a line without one. */
  versions: (string | null)[];
  documents: Series;
  tags: Series;
  links: Series;
  brokenLinks: Series;
  chunks: Series;
  embeddings: Series;
  byType: Record<string, Series>;
  byStatus: Record<string, Series>;
  byRelevance: Record<string, Series>;
  health: Record<(typeof HEALTH)[number], Series>;
  size: Record<(typeof SIZE)[number], Series>;
}

/** The UTC calendar day of `now`, as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True for a real `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** The Monday that starts `date`'s ISO week, as `YYYY-MM-DD`. */
function isoWeek(date: string): string {
  const ms = dayMs(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(ms - weekday * 86_400_000).toISOString().slice(0, 10);
}

/** Reduce `BrainStats` to the snapshot kept for `now`'s day. */
export function snapshotOf(stats: BrainStats, { now, version }: { now: Date; version: string }): StatsSnapshot {
  const { health, size } = stats;
  return {
    date: utcDay(now),
    at: now.toISOString(),
    version,
    documents: stats.documents,
    byType: stats.byType,
    byStatus: stats.byStatus,
    byRelevance: stats.byRelevance,
    tags: stats.tags,
    links: stats.links,
    brokenLinks: stats.brokenLinks,
    chunks: stats.chunks,
    embeddings: stats.embeddings,
    health: {
      brokenLinkRate: health.brokenLinkRate,
      embeddingCoverage: health.embeddingCoverage,
      stale: health.stale,
      orphans: health.orphans,
      untagged: health.untagged,
    },
    size: {
      corpusBytes: size.corpus?.bytes ?? null,
      corpusFiles: size.corpus?.files ?? null,
      dbBytes: size.db.bytes,
      dbRows: Object.values(size.db.tables).reduce((sum, n) => sum + n, 0),
      vectorsLive: size.db.vectorSlots.live,
      vectorsAllocated: size.db.vectorSlots.allocated,
      freeBytes: size.freeBytes,
    },
  };
}

function historyPath(root: string): string {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    real = resolve(root);
  }
  return join(real, STATS_HISTORY_FILE);
}

/**
 * A snapshot as read from the file: an object with a valid `date`, and
 * whatever else it carried. Fields are checked when a series reads them, so
 * an older (or newer) line with fewer (or more) fields still parses.
 */
type StoredSnapshot = Partial<StatsSnapshot> & { date: string; at?: string };

/**
 * Parse the history file. A line that is not a snapshot is an error, not a
 * line to skip: recording rewrites the file, and skipping would delete it —
 * a merge conflict marker left in the file must be resolved by hand, not
 * erased by the next cron run. Two lines for one day (two clones recorded,
 * then merged) resolve to the later recording.
 */
export function parseHistory(text: string): StoredSnapshot[] {
  const byDate = new Map<string, StoredSnapshot>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${STATS_HISTORY_FILE} line ${i + 1} is not JSON; fix or remove it by hand`);
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { date?: unknown }).date !== "string" ||
      !isIsoDate((value as { date: string }).date)
    ) {
      throw new Error(`${STATS_HISTORY_FILE} line ${i + 1} is not a snapshot (no YYYY-MM-DD date); fix or remove it by hand`);
    }
    const snapshot = value as StoredSnapshot;
    const seen = byDate.get(snapshot.date);
    if (!seen || String(snapshot.at ?? "") >= String(seen.at ?? "")) byDate.set(snapshot.date, snapshot);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Read the stored snapshots, oldest first. No file is an empty history. */
export function readHistory(root: string): StoredSnapshot[] {
  const path = historyPath(root);
  if (!existsSync(path)) return [];
  return parseHistory(readFileSync(path, "utf8"));
}

/**
 * Keep every snapshot of the last `DAILY_DAYS` days before `today`, and of the
 * older ones only the latest of each ISO week. The week's latest is judged
 * over every snapshot in the week, including any still inside the daily
 * window, so a week straddling the cutoff keeps the entry it will keep for
 * good.
 */
export function thin<T extends { date: string }>(snapshots: T[], today: string): T[] {
  const cutoff = dayMs(today) - DAILY_DAYS * 86_400_000;
  const latestOfWeek = new Map<string, string>();
  for (const s of snapshots) {
    const week = isoWeek(s.date);
    const latest = latestOfWeek.get(week);
    if (latest === undefined || s.date > latest) latestOfWeek.set(week, s.date);
  }
  return snapshots.filter((s) => dayMs(s.date) >= cutoff || latestOfWeek.get(isoWeek(s.date)) === s.date);
}

export interface RecordResult {
  date: string;
  /** Whether a snapshot for this day was already there and got replaced. */
  replaced: boolean;
  /** Snapshots in the file after this recording. */
  kept: number;
  /** Older snapshots thinning dropped in this recording. */
  thinned: number;
}

/**
 * Add `snapshot` to the history: replace the day's entry if there is one,
 * thin, and rewrite the file sorted by date.
 */
export function recordSnapshot(root: string, snapshot: StatsSnapshot): RecordResult {
  const existing = readHistory(root);
  const replaced = existing.some((s) => s.date === snapshot.date);
  const merged = [...existing.filter((s) => s.date !== snapshot.date), snapshot as StoredSnapshot].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const kept = thin(merged, snapshot.date);
  writeFileSafely(historyPath(root), kept.map((s) => JSON.stringify(s)).join("\n") + "\n");
  return { date: snapshot.date, replaced, kept: kept.length, thinned: merged.length - kept.length };
}

/** A stored value as a series entry: a finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Keys by code unit, never `localeCompare`: the runtime's locale is not pinned. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The stored snapshots on or after `since` (inclusive), as one series per field. */
export function historySeries(snapshots: StoredSnapshot[], since?: string): StatsHistory {
  const rows = since === undefined ? snapshots : snapshots.filter((s) => s.date >= since);
  const column = (read: (s: StoredSnapshot) => unknown): Series => rows.map((s) => num(read(s)));

  const breakdown = (field: (typeof BREAKDOWNS)[number]): Record<string, Series> => {
    const keys = new Set<string>();
    for (const s of rows) for (const key of Object.keys(record(s[field]) ?? {})) keys.add(key);
    const out: Record<string, Series> = {};
    for (const key of [...keys].sort(byCodeUnit)) {
      out[key] = rows.map((s) => {
        const map = record(s[field]);
        return map === null ? null : (num(map[key]) ?? 0);
      });
    }
    return out;
  };

  const history = {
    dates: rows.map((s) => s.date),
    recordedAt: rows.map((s) => (typeof s.at === "string" ? s.at : null)),
    versions: rows.map((s) => (typeof s.version === "string" ? s.version : null)),
  } as StatsHistory;
  for (const field of COUNTS) history[field] = column((s) => s[field]);
  for (const field of BREAKDOWNS) history[field] = breakdown(field);
  history.health = Object.fromEntries(
    HEALTH.map((field) => [field, column((s) => record(s.health)?.[field])])
  ) as StatsHistory["health"];
  history.size = Object.fromEntries(
    SIZE.map((field) => [field, column((s) => record(s.size)?.[field])])
  ) as StatsHistory["size"];
  return history;
}
