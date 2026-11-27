/**
 * Whether the index still describes the markdown on disk. One definition,
 * shared by the MCP read tools' staleness warning and `brain doctor`'s `db`
 * check, so the two can never disagree about the same brain (#1349).
 */
import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { resolve } from "path";

import { getMarkdownFiles } from "../indexer.js";
import type { Taxonomy } from "../taxonomy.js";

export interface IndexStaleness {
  /** Markdown files newer than their index row, missing from the index, or indexed and since deleted. */
  stale: number;
  /** Markdown documents in the index. */
  indexed: number;
}

/**
 * Compare every markdown file the indexer would scan with its `indexed_at`.
 * A file is stale when it was modified after it was indexed, was never
 * indexed, or is indexed but no longer on disk.
 */
export function indexStaleness(db: Database, root: string, taxonomy: Taxonomy): IndexStaleness {
  const rows = db
    .prepare("SELECT path, indexed_at FROM documents WHERE asset_type = 'markdown'")
    .all() as { path: string; indexed_at: string }[];
  const indexed = new Map(rows.map((r) => [r.path, Date.parse(r.indexed_at)]));

  let stale = 0;
  const seen = new Set<string>();
  for (const path of getMarkdownFiles(root, taxonomy)) {
    seen.add(path);
    const indexedAt = indexed.get(path);
    try {
      if (indexedAt === undefined || statSync(resolve(root, path)).mtimeMs > indexedAt) stale++;
    } catch {
      // Vanished between the scan and the stat: already marked seen, so not counted.
    }
  }
  for (const path of indexed.keys()) if (!seen.has(path)) stale++;
  return { stale, indexed: rows.length };
}

/** The shortest time one staleness probe answers for. */
export const STALENESS_MIN_TTL_MS = 10_000;
/** How many times its own duration one probe answers for, at least. */
export const STALENESS_TTL_PROBE_MULTIPLE = 20;

export interface StalenessCache {
  /** The cached answer, or a new probe's when the last one has expired. */
  read(): string | null;
  /** Forget the cached answer, so the next read probes. A write that indexes calls it. */
  reset(): void;
}

/**
 * One staleness probe's answer, shared by every read until it expires. An
 * answer lasts the larger of `STALENESS_MIN_TTL_MS` and
 * `STALENESS_TTL_PROBE_MULTIPLE` times the probe's measured duration, counted
 * from the probe's start, so on any size of brain the probe takes a bounded
 * share of a busy server's time. A probe that throws answers `null`, which is
 * cached like any answer: it never breaks a read. `now` is the clock in
 * milliseconds.
 */
export function cachedStaleness(probe: () => string | null, now: () => number): StalenessCache {
  let cache: { at: number; ttl: number; warning: string | null } | null = null;
  return {
    read() {
      const start = now();
      if (cache && start - cache.at < cache.ttl) return cache.warning;
      let warning: string | null = null;
      try {
        warning = probe();
      } catch {
        // Never let the staleness probe break a read.
      }
      cache = { at: start, ttl: Math.max(STALENESS_MIN_TTL_MS, (now() - start) * STALENESS_TTL_PROBE_MULTIPLE), warning };
      return warning;
    },
    reset() {
      cache = null;
    },
  };
}

/** The read tools' warning for `stale` stale files: one sentence for MCP and the CLI. */
export function staleWarning(stale: number): string {
  return `index is stale (${stale} file(s) newer than index); run \`brain index\``;
}
