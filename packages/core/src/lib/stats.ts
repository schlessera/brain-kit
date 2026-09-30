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
import { loadVecSupport, vecTableExists } from "./db.js";
import { embeddingEligibilitySql } from "./embedding-policy.js";
import { gitIgnoredMatcher, isAssetPath } from "./git-ignore.js";
import { readVectorSlots, type VectorSlots } from "./indexer/compact.js";
import type { Taxonomy } from "./taxonomy.js";
import type { StatsTrends } from "./stats-trends.js";

export interface StatsThresholds {
  coverageFloor: number;
  brokenLinkCeiling: number;
}

export interface BrainStats {
  /** CLI enrichment from recorded history; collection itself measures now. */
  trends?: StatsTrends;
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRelevance: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
  /**
   * Rows in vec_chunks. 0 when the brain has no vector table; null when it has
   * one that could not be counted (sqlite-vec would not load) — never 0 then.
   */
  embeddings: number | null;
  health: {
    /** brokenLinks / links; null when the corpus has no links to judge. */
    brokenLinkRate: number | null;
    /** Eligible chunks with vectors / eligible chunks; null with no eligible chunks or no measurable coverage. */
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
    /**
     * brain.db plus its WAL on disk (a rebuild-cost figure — the index is
     * disposable), its row counts, and the vector table's live rows against
     * the slots sqlite-vec has allocated for them. `live` is null when the
     * extension will not load; `allocated` is null then, and also when its
     * chunk table is not in the shape this version knows.
     */
    db: { bytes: number | null; tables: Record<string, number>; vectorSlots: VectorSlots };
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

/**
 * The effective warn levels: the config `stats` block over the documented
 * defaults. Resolved key by key rather than by spreading the block, because
 * zod keeps an explicitly-`undefined` optional key (`{ coverageFloor:
 * undefined }` parses to an object that HAS `coverageFloor`), and a spread
 * would let it overwrite the default with `undefined` — which JSON.stringify
 * then drops, taking the field out of `--json` entirely.
 */
export function resolveStatsThresholds(config: BrainConfig | null): StatsThresholds {
  const stats = config?.stats;
  return {
    coverageFloor: stats?.coverageFloor ?? DEFAULT_STATS_THRESHOLDS.coverageFloor,
    brokenLinkCeiling: stats?.brokenLinkCeiling ?? DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling,
  };
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
 * afterwards. `isExcludedDirectory` applies only `dirs` and `segments`, with
 * a trailing slash so root and nested directory segments both match. Exact
 * `files` entries never prune a directory, even when a programmatic caller
 * bypasses config validation (#224). `buildTaxonomy` normalises every
 * `exclude.dirs` entry to `drafts`, never `drafts/` or `./drafts`, so the
 * directory walk and the indexer's per-file checks agree (#139).
 * Pruning does two things a post-filter
 * cannot: `node_modules` is never walked, and a `workspaces/` the user cannot
 * read cannot raise EACCES from inside a directory nobody asked about.
 *
 * An asset git ignores is left out, as the indexer leaves it out, through the
 * same `gitIgnoredMatcher`; an ignored markdown file, like any other ignored
 * non-asset file, is still counted.
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
  // The index leaves out assets git ignores; so does this count (#433).
  const ignored = gitIgnoredMatcher(root);

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

      // Symlinks are skipped in both directions, which is what the indexer's
      // glob does (`followSymlinks` is off by default). A link to a directory
      // is not descended into — a cycle would not terminate — and a link to a
      // file is not weighed, because its bytes are already counted where the
      // target lives. A differential run over a tree of links, dotfiles and
      // nested excludes says this walk keeps exactly the set the glob kept.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (taxonomy.isExcludedDirectory(path)) continue;
        if (!walk(path)) complete = false;
        continue;
      }
      if (!entry.isFile()) continue;
      if (indexFiles.has(path)) continue;
      if (taxonomy.isExcludedPath(path)) continue;
      if (isAssetPath(path) && ignored(path)) continue;
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
  const eligible = embeddingEligibilitySql(taxonomy);
  const eligibleChunkCount = (db.prepare(`SELECT COUNT(*) AS count FROM chunks c
    JOIN documents d ON d.id = c.document_id WHERE ${eligible.sql}`)
    .get(...eligible.params) as { count: number }).count;

  // vec_chunks is a vec0 virtual table: counting it needs the extension on
  // this connection, and an older or hand-built database may not have it at
  // all. Those are different answers. With no table there is nothing to
  // count, so `embeddings` is a known 0. With a table the extension cannot
  // read, the count is unknown, and `embeddings` is null rather than a 0 that
  // reads exactly like a brain holding no vectors.
  //
  // The table is looked for first, through sqlite_master, so a keyless brain
  // is answered without loading the extension at all — and without the
  // "sqlite-vec not available" warning a failed load prints. When the table IS
  // there and the extension will not load, that warning is the point: the
  // brain holds vectors this host cannot read. `loadVecSupport` is the read
  // path and only loads the extension; `migrateVecSchema` would also run the
  // vec0 schema migrations, one of which is a bare `DROP TABLE vec_chunks`,
  // and counting rows is not a reason to migrate anything.
  let vecTable = vecTableExists(db);
  let embeddingCount: number | null = null;
  let eligibleEmbeddingCount: number | null = null;
  if (vecTable) {
    const vec = await loadVecSupport(db);
    if (vec.ok) {
      try {
        embeddingCount = count(db, "SELECT COUNT(*) as count FROM vec_chunks");
        eligibleEmbeddingCount = (db.prepare(`SELECT COUNT(*) AS count FROM vec_chunks v
          JOIN chunks c ON c.id = v.chunk_id JOIN documents d ON d.id = c.document_id
          WHERE ${eligible.sql}`).get(...eligible.params) as { count: number }).count;
      } catch {
        // a table the extension cannot read — still unknown, still not 0
      }
    } else if (vec.reason === "no-vector-table") {
      // dropped between the two looks: nothing to count after all
      vecTable = false;
    }
  }

  // Coverage only means something for a brain that embeds: one with a
  // provider configured, or one that already holds vectors. A keyless brain
  // gets an empty vec_chunks from every `brain index`, and "0% embedded"
  // there would be a warning nobody can act on. A brain with no vec_chunks at
  // all has no coverage either. Neither does one with no eligible chunks.
  const embeddingCoverage =
    eligibleEmbeddingCount !== null && (opts.embeddingsConfigured || (embeddingCount ?? 0) > 0) && eligibleChunkCount > 0
      ? eligibleEmbeddingCount / eligibleChunkCount
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
    embeddings: vecTable ? embeddingCount : 0,
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
      db: { bytes: dbBytes, tables: tableCounts(db), vectorSlots: readVectorSlots(db) },
      freeBytes: freeSpaceBytes(root, opts.statfs),
    },
  };
}
