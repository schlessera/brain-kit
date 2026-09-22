/**
 * The numbers behind `brain stats`: the raw counts the command has always
 * reported, the health ratios derived from them, and what the brain costs on
 * disk. One function so `--json` and the human output cannot drift apart.
 *
 * Staleness and orphans are not defined here. They come from the auditor
 * (findStale / findOrphans), which reads the per-type `staleDays` and
 * `orphanExempt` from the taxonomy, so `brain stats` counts exactly what
 * `brain audit` lists.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, statSync, statfsSync } from "fs";
import { join, relative } from "path";

import { findOrphans, findStale, loadAuditDocs } from "./auditor.js";
import { DEFAULT_STATS_THRESHOLDS, type BrainConfig } from "./config.js";
import type { Taxonomy } from "./taxonomy.js";

export interface StatsThresholds {
  coverageFloor: number;
  brokenLinkCeiling: number;
}

export interface BrainStats {
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRelevance: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
  embeddings: number;
  health: {
    /** brokenLinks / links; null when the corpus has no links to judge. */
    brokenLinkRate: number | null;
    /** embeddings / chunks; null when this brain neither embeds nor holds vectors, or has no chunks. */
    embeddingCoverage: number | null;
    /** Markdown documents past their type's staleDays — the audit definition. */
    stale: number;
    /** Markdown documents with no wiki-link either way — the audit definition, honouring orphanExempt. */
    orphans: number;
    /** Non-archived markdown documents with no tags. */
    untagged: number;
    /** The warn levels in force (config `stats` block over the defaults). */
    thresholds: StatsThresholds;
  };
  size: {
    /** Files under the root that the index would consider, and their bytes; null when a wanted directory could not be read. */
    corpus: { bytes: number; files: number } | null;
    /** brain.db plus its WAL on disk (a rebuild-cost figure — the index is disposable) and its row counts. */
    db: { bytes: number | null; tables: Record<string, number> };
    /** Bytes available to this user on the volume holding the brain; null when it could not be read. */
    freeBytes: number | null;
  };
}

export interface CollectStatsOptions {
  root: string;
  dbPath: string;
  taxonomy: Taxonomy;
  config: BrainConfig | null;
  /** Wall clock for staleness — injected for deterministic tests. */
  now?: Date;
  /** An embedding provider is configured for this brain (key present or not). */
  embeddingsConfigured?: boolean;
  /** Free-space probe — injected so a test can make it fail. */
  statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
}

/** The effective warn levels: the config `stats` block over the documented defaults. */
export function resolveStatsThresholds(config: BrainConfig | null): StatsThresholds {
  return { ...DEFAULT_STATS_THRESHOLDS, ...(config?.stats ?? {}) };
}

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

/**
 * Row counts for every table of our own in the schema. Shadow tables that
 * FTS5 and vec0 keep behind a virtual table (documents_fts_data,
 * vec_chunks_rowids, …) are internals and are skipped; a table that cannot be
 * counted on this connection (vec_chunks without the extension) is left out
 * rather than reported as 0.
 */
function tableCounts(db: Database): Record<string, number> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string | null }[];
  const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? "")).map((r) => r.name);
  const tables: Record<string, number> = {};
  for (const { name } of rows) {
    if (virtual.some((v) => name.startsWith(`${v}_`))) continue;
    try {
      tables[name] = count(db, `SELECT COUNT(*) as count FROM "${name}"`);
    } catch {
      // virtual table whose module is not loaded on this connection
    }
  }
  return tables;
}

/**
 * What the brain weighs on disk: every file under the root that is not
 * excluded and not the index itself. This is the corpus as a *user* sees it
 * (notes, assets, the config), not the subset the indexer picks up — the same
 * `isExcludedPath` decides, dot files are skipped the way the indexer's glob
 * skips them (so `.git` never lands here), and brain.db with its journal
 * sidecars is the index, which is disposable and counted separately.
 *
 * Excluded directories are pruned BEFORE descending rather than filtered
 * afterwards. Testing `dir + "/"` gives `isExcludedPath` the same answer it
 * would give for every file inside — both its `dirs` and its `segments` rules
 * match on that trailing slash — so pruning cannot change the total. It does
 * two things a post-filter cannot: `node_modules` is never walked, and a
 * `workspaces/` the user cannot read cannot raise EACCES from inside a
 * directory nobody asked about.
 *
 * Null, not a smaller number, when a directory that *was* wanted could not be
 * read: a corpus size short by an unknown amount is worse than no figure.
 */
function corpusSize(
  root: string,
  dbPath: string,
  taxonomy: Taxonomy
): { bytes: number; files: number } | null {
  const dbRel = relative(root, dbPath);
  const indexFiles = new Set([dbRel, `${dbRel}-wal`, `${dbRel}-shm`, `${dbRel}-journal`]);
  let bytes = 0;
  let files = 0;

  const walk = (rel: string): boolean => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    let complete = true;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;

      // A symlink is resolved once, here: a link to a file counts as that
      // file, a link to a directory is not descended into (the indexer's glob
      // does not follow them either, and a cycle would not terminate).
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(root, path)).isDirectory();
        } catch {
          continue; // dangling link — nothing on disk to weigh
        }
        if (isDir) continue;
      }

      if (isDir) {
        if (taxonomy.isExcludedPath(`${path}/`)) continue;
        if (!walk(path)) complete = false;
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (indexFiles.has(path)) continue;
      if (taxonomy.isExcludedPath(path)) continue;
      try {
        bytes += statSync(join(root, path)).size;
        files += 1;
      } catch {
        // vanished between listing and stat
      }
    }
    return complete;
  };

  return walk("") ? { bytes, files } : null;
}

/** Free bytes on the volume holding `path`; null when the platform call fails. */
export function freeSpaceBytes(
  path: string,
  statfs: CollectStatsOptions["statfs"] = statfsSync
): number | null {
  try {
    const s = statfs(path);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Whether this database carries a vec_chunks table at all. Checked through
 * sqlite_master so a keyless brain is answered without loading the extension
 * (and without the "sqlite-vec not available" warning that a failed load on a
 * read-only connection would print).
 */
function hasVecTable(db: Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
    .get() as { present: number } | null;
  return row !== null;
}

/**
 * Collect every figure `brain stats` reports. Nothing here fails the command:
 * a figure that cannot be measured is null, never 0.
 */
export async function collectStats(db: Database, opts: CollectStatsOptions): Promise<BrainStats> {
  const { root, dbPath, taxonomy } = opts;
  const now = (opts.now ?? new Date()).getTime();

  const docCount = count(db, "SELECT COUNT(*) as count FROM documents");
  const typeBreakdown = db.prepare("SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC").all() as { type: string; count: number }[];
  const statusBreakdown = db.prepare("SELECT status, COUNT(*) as count FROM documents GROUP BY status ORDER BY count DESC").all() as { status: string; count: number }[];
  const relevanceBreakdown = db.prepare("SELECT relevance, COUNT(*) as count FROM documents GROUP BY relevance ORDER BY count DESC").all() as { relevance: string; count: number }[];
  const tagCount = count(db, "SELECT COUNT(*) as count FROM tags");
  const linkCount = count(db, "SELECT COUNT(*) as count FROM links");
  const brokenLinks = count(db, "SELECT COUNT(*) as count FROM links WHERE target_id IS NULL");
  const chunkCount = count(db, "SELECT COUNT(*) as count FROM chunks");

  // vec_chunks is a vec0 virtual table: counting it needs the extension on
  // this connection, and an older or hand-built database may not have it at
  // all. Either way the count is unknown, not 0.
  let embeddingCount: number | null = null;
  if (hasVecTable(db)) {
    try {
      // Load the extension and nothing else. `initVecSupport` would also run
      // the vec0 schema migrations, and one of them is a bare
      // `DROP TABLE vec_chunks` — on a writable connection to a pre-cosine
      // index, merely asking for statistics would destroy the vectors and
      // charge a re-embedding run to get them back. Counting rows is not a
      // reason to migrate anything.
      const { load } = await import("sqlite-vec");
      load(db);
      embeddingCount = count(db, "SELECT COUNT(*) as count FROM vec_chunks");
    } catch {
      // extension unavailable — same answer as no table
    }
  }

  // Coverage only means something for a brain that embeds: one with a
  // provider configured, or one that already holds vectors. A keyless brain
  // gets an empty vec_chunks from every `brain index`, and "0% embedded"
  // there would be a warning nobody can act on.
  const embeddingCoverage =
    embeddingCount !== null && (opts.embeddingsConfigured || embeddingCount > 0) && chunkCount > 0
      ? embeddingCount / chunkCount
      : null;

  const docs = loadAuditDocs(db);
  const stale = findStale(docs, taxonomy, now).length;
  const orphans = findOrphans(db, docs, taxonomy).length;
  const untagged = count(
    db,
    `SELECT COUNT(*) as count FROM documents d
     WHERE d.asset_type = 'markdown' AND d.status != 'archived'
       AND NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)`
  );

  // The WAL holds committed rows until the next checkpoint, so right after an
  // index run the main file can be one page while the journal has the data.
  let dbBytes: number | null = null;
  try {
    dbBytes = statSync(dbPath).size;
    try {
      dbBytes += statSync(`${dbPath}-wal`).size;
    } catch {
      // no journal at the moment
    }
  } catch {
    // not a file-backed database
  }

  return {
    documents: docCount,
    byType: Object.fromEntries(typeBreakdown.map((r) => [r.type, r.count])),
    byStatus: Object.fromEntries(statusBreakdown.map((r) => [r.status, r.count])),
    byRelevance: Object.fromEntries(relevanceBreakdown.map((r) => [r.relevance, r.count])),
    tags: tagCount,
    links: linkCount,
    brokenLinks,
    chunks: chunkCount,
    embeddings: embeddingCount ?? 0,
    health: {
      brokenLinkRate: linkCount > 0 ? brokenLinks / linkCount : null,
      embeddingCoverage,
      stale,
      orphans,
      untagged,
      thresholds: resolveStatsThresholds(opts.config),
    },
    size: {
      corpus: corpusSize(root, dbPath, taxonomy),
      db: { bytes: dbBytes, tables: tableCounts(db) },
      freeBytes: freeSpaceBytes(root, opts.statfs),
    },
  };
}
