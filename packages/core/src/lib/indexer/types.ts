/**
 * The indexer's vocabulary: what a run is given, what it reports, and the
 * intermediate shapes its phases hand to each other.
 *
 * `IndexRun` is the piece that makes the pipeline composable. Every phase
 * takes it, so a phase's signature says what it consumes and produces rather
 * than closing over a thousand lines of shared locals — and `report()`
 * replaces the `if (!quiet) console.log(...)` that used to be repeated at
 * every step.
 */
import type { Database } from "bun:sqlite";

import type { Asset } from "../types.js";
import type { EmbeddingProvider } from "../seams.js";
import type { Enrichment } from "../enrichment.js";
import type { Taxonomy } from "../taxonomy.js";

export interface IndexStats {
  total: number;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  chunks: number;
  embeddings: number;
  assets: number;
  /** Wall time of the graph precompute; 0 when it was skipped. */
  graphMs: number;
  /** Markdown documents in the rebuilt graph; 0 when it was skipped. */
  graphNodes: number;
}

/**
 * Everything the indexer needs beyond the database handle. `root` and
 * `taxonomy` replace the module-level ROOT/DB_PATH and the hardcoded
 * type/dir/exclusion/anchor tables of the reference brain. The embedding
 * provider and enrichment are injected seams (config resolves the built-ins);
 * absent, embedding/description work degrades exactly as the source did with
 * no API key configured.
 */
export interface IndexOptions {
  root: string;
  taxonomy: Taxonomy;
  force?: boolean;
  quiet?: boolean;
  /** Run the embedding pass (chunk vectors + multimodal asset vectors). */
  embeddings?: boolean;
  /** Injected embedding provider; absent → no vectors are written. */
  provider?: EmbeddingProvider;
  /** Injected enrichment (asset descriptions + chunk contexts); absent → degrades. */
  enrichment?: Enrichment;
  /** Rebuild the derived graph tables at the end of the run. Default: true. */
  graph?: boolean;
}

/** Shared, read-mostly state threaded through every phase of one index run. */
export interface IndexRun {
  db: Database;
  root: string;
  taxonomy: Taxonomy;
  force: boolean;
  /** Run the embedding pass (chunk vectors + multimodal asset vectors). */
  wantEmbeddings: boolean;
  /** Injected embedding provider; absent → no vectors are written. */
  provider?: EmbeddingProvider;
  /** Injected enrichment (asset descriptions + chunk contexts). */
  enrichment?: Enrichment;
  /** ISO timestamp stamped on every row this run writes. One per run, so a
   *  run's documents share an `indexed_at` and staleness comparisons are
   *  stable regardless of how long the run took. */
  now: string;
  stats: IndexStats;
  /** Progress line, suppressed by `quiet`. */
  report(message: string): void;
  /** Warning line on stderr, including in quiet/JSON mode. */
  warn(message: string): void;
}

/** A markdown file that parsed cleanly and needs (re)writing to the index. */
export interface ParsedFile {
  path: string;
  data: Record<string, any>;
  content: string;
  hash: string;
  mtime: string;
  isNew: boolean;
  isChanged: boolean;
}

/** The document rows already in the index, keyed by path, as the run found them. */
export interface ExistingDoc {
  id: number;
  content_hash: string | null;
  accepted_mtime: string | null;
  stat_fingerprint: string | null;
}

/** What the parse phase learned about the corpus as a whole. */
export interface ParseResult {
  files: ParsedFile[];
  /** path -> title, for every VALID markdown file (not just changed ones) —
   *  wiki-link resolution needs the whole corpus. */
  fileMap: Map<string, string>;
  /** lowercased alias -> paths claiming it, corpus-wide for the same reason. */
  aliasMap: Map<string, string[]>;
}

/** An asset whose bytes changed (or whose description needs a retry). */
export interface AssetTask {
  asset: Asset;
  /** Bytes, when already read; null means "read lazily at describe time". */
  raw: Buffer | null;
  docId: number;
  hash: string;
}

/** An asset queued for vector embedding, with the description to embed. */
export interface AssetEmbedTask {
  docId: number;
  path: string;
  mimeType: string;
  description: string;
  docType: string;
}

/** What the markdown persist phase produced for the phases downstream. */
export interface PersistResult {
  /** Document ids whose chunks were (re)written and so need embedding. */
  docIdsNeedingEmbedding: number[];
}
