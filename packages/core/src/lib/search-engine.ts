import { Database } from "bun:sqlite";

import { SEARCH_SORTS, type SearchResult, type SearchOptions } from "./types.js";
import type { EmbeddingProvider } from "./seams.js";
import type { Taxonomy } from "./taxonomy.js";
import { hasVecSupport, getMeta, embeddingIdentityMatches } from "./db.js";
import { rerank, getDefaultRerankerMode } from "./reranker.js";

export interface SearchResponse {
  results: SearchResult[];
  /** Degraded-mode notices: requested search modes that were unavailable and why. */
  warnings: string[];
}

/**
 * Injected capabilities the search needs beyond the database. The embedding
 * provider is optional: absent, vector/hybrid modes degrade to FTS-only with a
 * warning — the same behaviour the source had when no API key was configured.
 */
export interface SearchDeps {
  embeddings?: EmbeddingProvider;
  /** The brain's types, for the reranker's recency half-lives. Defaults to
   * the core types alone. */
  taxonomy?: Taxonomy;
  /** Interactive vector budget; must finish before the UI CLI deadline. */
  queryTimeoutMs?: number;
}

interface FilterResult {
  where: string;
  params: any[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const DATE_FILTERS = [
  ["updatedSince", "updated", ">="],
  ["updatedBefore", "updated", "<="],
  ["deadlineFrom", "deadline", ">="],
  ["deadlineTo", "deadline", "<="],
] as const;

/**
 * The first invalid date filter or sort in `opts`, as a message, or null.
 * Callers check this before searching, so a bad date is an error rather than
 * a lane that quietly matches nothing.
 */
export function searchOptionsError(opts: SearchOptions): string | null {
  for (const [key] of DATE_FILTERS) {
    const value = opts[key];
    if (value !== undefined && (typeof value !== "string" || !isIsoDate(value))) {
      return `${key} must be a date written YYYY-MM-DD, got ${JSON.stringify(value)}`;
    }
  }
  if (opts.sort !== undefined && !SEARCH_SORTS.includes(opts.sort)) {
    return `sort must be one of ${SEARCH_SORTS.join(", ")}, got ${JSON.stringify(opts.sort)}`;
  }
  return null;
}

function assertSearchOptions(opts: SearchOptions): void {
  const error = searchOptionsError(opts);
  if (error) throw new Error(error);
}

/**
 * Build SQL WHERE clause fragments from search options.
 */
function buildFilters(opts: SearchOptions): FilterResult {
  const clauses: string[] = [];
  const params: any[] = [];

  if (!opts.includeArchived) {
    clauses.push("d.status != ?");
    params.push("archived");
  }

  if (opts.type) {
    clauses.push("d.type = ?");
    params.push(opts.type);
  }

  if (opts.relevance) {
    clauses.push("d.relevance = ?");
    params.push(opts.relevance);
  }

  if (opts.status) {
    clauses.push("d.status = ?");
    params.push(opts.status);
  }

  if (opts.tag) {
    clauses.push(
      "d.id IN (SELECT dt.document_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.name = ?)"
    );
    params.push(opts.tag);
  }

  if (opts.assetsOnly) {
    clauses.push("d.asset_type != ?");
    params.push("markdown");
  }

  for (const [key, column, op] of DATE_FILTERS) {
    if (opts[key] === undefined) continue;
    clauses.push(`${storedDate(column, "date")} ${op} ?`);
    params.push(opts[key]);
  }

  return {
    where: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
  };
}

/**
 * A stored date as SQL: `fn` (date() for a UTC day, julianday() for an
 * exact instant) of the column when it holds a valid ISO date or datetime,
 * else NULL, which matches no bound and sorts last.
 *
 * Stored dates are frontmatter strings: a bare `YYYY-MM-DD`, or that
 * followed by `T` or a space, `HH:MM`, optional seconds and fraction, and an
 * optional `Z` or `±HH:MM` offset. SQLite's own parser is lenient where this
 * must not be: it rolls `2026-02-30` over to March 2, reads `now` as the
 * current time, a bare number as a Julian day, and accepts hour 24 and a bare
 * trailing `T`. So the first ten characters must survive a date() round trip
 * unchanged (which only a real `YYYY-MM-DD` does), and any time part must
 * start `HH:MM` with an hour below 24 and parse.
 */
function storedDate(column: "updated" | "deadline", fn: "date" | "julianday"): string {
  const c = `d.${column}`;
  const valid =
    `date(substr(${c}, 1, 10)) = substr(${c}, 1, 10) ` +
    `AND (length(${c}) = 10 OR (` +
    `substr(${c}, 11) GLOB '[T ][0-2][0-9]:[0-5][0-9]*' ` +
    `AND substr(${c}, 12, 2) < '24' AND julianday(${c}) IS NOT NULL))`;
  return `(CASE WHEN ${valid} THEN ${fn}(${c}) END)`;
}

/** Date-sort keys: the validated instant, full precision, NULL last. */
const DATE_SORT_KEY = {
  updated: storedDate("updated", "julianday"),
  deadline: storedDate("deadline", "julianday"),
} as const;

/**
 * Filter-only search (no query text). Returns documents matching filters,
 * ordered by updated date descending; with `sort: "updated"` or
 * `sort: "deadline"`, by the normalised date, newest update or earliest
 * deadline first, with a missing or malformed date last.
 */
export function filterSearch(db: Database, opts: SearchOptions): SearchResult[] {
  assertSearchOptions(opts);
  const limit = opts.limit ?? 20;
  const filters = buildFilters(opts);
  const order =
    opts.sort === "deadline"
      ? `${DATE_SORT_KEY.deadline} IS NULL, ${DATE_SORT_KEY.deadline} ASC, d.updated DESC`
      : opts.sort === "updated"
        ? `${DATE_SORT_KEY.updated} IS NULL, ${DATE_SORT_KEY.updated} DESC`
        : "d.updated DESC";

  const sql = `
    SELECT
      d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline,
      (SELECT GROUP_CONCAT(t.name, ', ')
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id = d.id) as tags,
      0 as score,
      '' as snippet
    FROM documents d
    WHERE 1=1 ${filters.where}
    ORDER BY ${order}
    LIMIT ?
  `;

  const params = [...filters.params, limit];
  return db.prepare(sql).all(...params) as SearchResult[];
}

/**
 * English function words dropped from a full-text query before its terms are
 * ORed. FTS5 ships no stopword list, and without one an OR of a question's
 * words matches nearly every document through "the" or "is". English only, to
 * match the `porter unicode61` tokenizer, which stems English only.
 */
const FTS_STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as",
  "at", "be", "been", "before", "being", "but", "by", "can", "could", "did",
  "do", "does", "doing", "for", "from", "had", "has", "have", "having", "he",
  "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "me", "my", "no", "nor", "not", "of", "on", "or",
  "our", "ours", "out", "over", "she", "should", "so", "some", "than", "that",
  "the", "their", "theirs", "them", "then", "there", "these", "they", "this",
  "those", "to", "too", "under", "up", "us", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours",
]);

/** Quote one token as an FTS5 phrase so `/ - : * (` stay literal. */
function quoteFtsTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build an FTS5 MATCH expression from a free-text query.
 *
 * Each token is quoted, stopwords are dropped and the rest are ORed, so a
 * question matches every document that shares a content word with it and
 * BM25 ranks the ones that share the rarest words first. FTS5 reads
 * space-separated phrases as AND, which starved the lane on natural questions
 * (#400). A query that is one quoted phrase stays a phrase. A query made only
 * of stopwords keeps the AND of all its terms, so "the who" still means
 * something.
 */
function sanitizeFtsQuery(query: string): string {
  // FTS5 escapes a quote inside a phrase by doubling it: `"a ""b"""`.
  const phrase = /^\s*"((?:[^"]|"")+)"\s*$/.exec(query);
  if (phrase) return quoteFtsTerm(phrase[1]!.replace(/""/g, '"').trim());

  const tokens = query.split(/\s+/).filter(Boolean);
  // A token with no letter or digit (`?`, `-`) is an empty phrase: FTS5's AND
  // skips it, but alone in an OR it matches nothing, so it is not a content term.
  const content = tokens.filter((token) => {
    const word = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    return word !== "" && !FTS_STOPWORDS.has(word);
  });
  if (content.length === 0) return tokens.map(quoteFtsTerm).join(" ");
  return [...new Set(content.map(quoteFtsTerm))].join(" OR ");
}

/**
 * Full-text search using FTS5.
 */
function ftsSearch(
  db: Database,
  query: string,
  opts: SearchOptions,
  candidates = (opts.limit ?? 20) * 2
): SearchResult[] {
  const filters = buildFilters(opts);
  query = sanitizeFtsQuery(query);

  // bm25() column weights: title 5x, summary 3x, content 1x, tags 2x —
  // frontmatter fields carry far more signal per token than body text.
  // bm25() returns negative values (better = more negative), hence the
  // negation for score and ascending ORDER BY.
  const sql = `
    SELECT
      d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline,
      (SELECT GROUP_CONCAT(t.name, ', ')
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id = d.id) as tags,
      -bm25(documents_fts, 5.0, 3.0, 1.0, 2.0) as score,
      snippet(documents_fts, 2, '>>>', '<<<', '...', 40) as snippet
    FROM documents_fts fts
    JOIN documents d ON d.id = fts.rowid
    WHERE documents_fts MATCH ? ${filters.where}
    ORDER BY bm25(documents_fts, 5.0, 3.0, 1.0, 2.0)
    LIMIT ?
  `;

  const params = [query, ...filters.params, candidates];
  return db.prepare(sql).all(...params) as SearchResult[];
}

/**
 * Build a snippet from chunk content: trim at a sentence boundary near the
 * target length instead of cutting mid-word.
 */
function makeSnippet(content: string, targetLength = 200): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= targetLength) return text;

  const window = text.slice(0, targetLength + 80);
  const sentenceEnd = window.search(/[.!?]\s/);
  if (sentenceEnd > targetLength * 0.4) {
    return window.slice(0, sentenceEnd + 1);
  }

  const lastSpace = text.lastIndexOf(" ", targetLength);
  return text.slice(0, lastSpace > 0 ? lastSpace : targetLength) + "…";
}

/** Bound even a third-party provider that ignores cancellation. Race only the
 * embedding request, so a late completion cannot query a caller-closed DB. */
async function embedSearchQuery(
  embeddings: EmbeddingProvider,
  query: string,
  timeoutMs: number
): Promise<Float32Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`query embedding timed out after ${timeoutMs}ms`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      embeddings.embedQuery(query, { signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vector similarity search using sqlite-vec KNN.
 */
async function vectorSearch(
  db: Database,
  query: string,
  opts: SearchOptions,
  embeddings: EmbeddingProvider,
  queryTimeoutMs: number
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const filters = buildFilters(opts);

  const queryEmbedding = await embedSearchQuery(embeddings, query, queryTimeoutMs);
  const queryBytes = new Uint8Array(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

  // Only is_archived and doc_type are KNN-prefiltered; tag/relevance/status/
  // assets/date filters run post-KNN, so widen the candidate window when they are
  // present or filtering starves the result set.
  const hasPostFilters = !!(
    opts.tag || opts.relevance || opts.status || opts.assetsOnly ||
    DATE_FILTERS.some(([key]) => opts[key] !== undefined)
  );
  let k = Math.min(Math.max(1, limit * (hasPostFilters ? 10 : 3)), 500);

  // KNN search on vec_chunks, pre-filtered on metadata columns so archived
  // chunks don't crowd active results out of the candidate window
  const knnClauses: string[] = [];
  const knnParams: any[] = [];
  if (!opts.includeArchived) {
    knnClauses.push("is_archived = 0");
  }
  if (opts.type) {
    knnClauses.push("doc_type = ?");
    knnParams.push(opts.type);
  }
  const knnWhere = knnClauses.length > 0 ? " AND " + knnClauses.join(" AND ") : "";

  // A long document may own most neighboring chunks. Widen after applying
  // filters and deduplicating, reusing the same query embedding. Geometric
  // growth bounds repeated work; 500 remains the hard candidate ceiling.
  for (;;) {
    let knnResults: { chunk_id: number; distance: number }[];
    try {
      knnResults = db
        .prepare(
          `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?${knnWhere}`
        )
        .all(queryBytes, k, ...knnParams) as typeof knnResults;
    } catch {
      // Pre-v2 vec schema without metadata columns (read-only session before
      // the next writable migration) — fall back to unfiltered KNN
      knnResults = db
        .prepare(
          `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?`
        )
        .all(queryBytes, k) as typeof knnResults;
    }

    if (knnResults.length === 0) return [];

    // Map chunk results back to documents
    const chunkIds = knnResults.map((r) => r.chunk_id);
    const distanceMap = new Map(knnResults.map((r) => [r.chunk_id, r.distance]));

    const placeholders = chunkIds.map(() => "?").join(",");
    const sql = `
      SELECT
        d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline,
        (SELECT GROUP_CONCAT(t.name, ', ')
         FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
         WHERE dt.document_id = d.id) as tags,
        c.id as chunk_id,
        c.content as chunk_content
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${placeholders}) ${filters.where}
    `;

    const rows = db.prepare(sql).all(...chunkIds, ...filters.params) as {
      path: string;
      title: string;
      type: string;
      relevance: string;
      status: string;
      summary: string | null;
      tags: string;
      updated: string;
      deadline: string | null;
      chunk_id: number;
      chunk_content: string;
    }[];

    // Deduplicate by document path, keeping the best-scoring chunk per doc
    const docMap = new Map<string, SearchResult>();
    for (const row of rows) {
      const distance = distanceMap.get(row.chunk_id) ?? Infinity;
      // Convert distance to a score (lower distance = higher score)
      const score = 1 / (1 + distance);
      const existing = docMap.get(row.path);

      if (!existing || score > existing.score) {
        docMap.set(row.path, {
          path: row.path,
          title: row.title,
          type: row.type,
          relevance: row.relevance,
          status: row.status,
          summary: row.summary,
          tags: row.tags,
          updated: row.updated,
          deadline: row.deadline,
          score,
          snippet: makeSnippet(row.chunk_content),
        });
      }
    }

    if (docMap.size >= limit || knnResults.length < k || k === 500) {
      return Array.from(docMap.values()).sort((a, b) => b.score - a.score);
    }
    k = Math.min(k * 2, 500);
  }
}

// Weighted reciprocal rank fusion (#404): a document scores
// sum(weight / (RRF_K + rank)) over the lanes that found it.
//
// PROVISIONAL. These constants are reasoned, not measured: the keyed
// before/after `brain eval` run that should choose them is its own issue
// (#468). Until it lands:
//
// - RRF_K = 60 is the Cormack, Clarke and Büttcher (SIGIR 2009) default.
// - The vector lane keeps weight 1. The full-text lane gets 0.8 because a
//   retrieval audit on 0.35.0 measured hybrid below vector-only on hit@1.
//   At 0.8, agreement still wins (FTS 1 + vector 3 ≈ 0.0290 against vector 1
//   alone ≈ 0.0164), and an FTS-only first place (≈ 0.0131) lands among
//   vector's mid-teens rather than above its top hits.
// - The pool guard: when the full-text lane returns fewer than
//   FTS_POOL_GUARD × limit candidates, the query barely matched as text and
//   those few hits would each collect a two-lane bonus. Their weight drops to
//   THIN_FTS_WEIGHT = 0.05, where an FTS first place is worth about three
//   vector ranks at the top (0.05 / 61 ≈ 0.00082 ≈ 1/61 − 1/64). That reduces
//   a thin lane's influence; it does not guarantee vector's first place wins.
//   An overlap already within about three ranks of the top (for example
//   vector 2 plus a thin FTS hit) can still pass it.
const RRF_K = 60;
const VECTOR_LANE_WEIGHT = 1.0;
const FTS_LANE_WEIGHT = 0.8;
const FTS_POOL_GUARD = 0.5;
const THIN_FTS_WEIGHT = 0.05;

/** The full-text lane's fusion weight for a pool of `ftsCount` candidates. */
export function ftsLaneWeight(ftsCount: number, limit: number): number {
  return ftsCount < FTS_POOL_GUARD * limit ? THIN_FTS_WEIGHT : FTS_LANE_WEIGHT;
}

/**
 * Merge weighted result lists with reciprocal rank fusion. A document found
 * by several lanes keeps the first lane's result object (its snippet) and
 * sums the lanes' weighted terms.
 */
export function weightedRankFusion(
  lanes: { results: SearchResult[]; weight: number }[]
): SearchResult[] {
  const scoreMap = new Map<string, { score: number; result: SearchResult }>();

  for (const { results, weight } of lanes) {
    for (let i = 0; i < results.length; i++) {
      const term = weight / (RRF_K + i + 1);
      const key = results[i].path;
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += term;
      } else {
        scoreMap.set(key, { score: term, result: results[i] });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.result,
      score: entry.score,
    }));
}

/** True when at least one vector is stored (cheap EXISTS probe). */
function vecStoreHasRows(db: Database): boolean {
  try {
    const row = db.prepare("SELECT EXISTS(SELECT 1 FROM vec_chunks) AS n").get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  }
}

/**
 * Hybrid search combining FTS5 and vector search with Reciprocal Rank Fusion.
 * The response carries `warnings` when a requested mode is degraded or
 * unavailable (no embedding provider, sqlite-vec not loaded, model-mismatched
 * or empty vector store, search errors).
 */
export async function hybridSearch(
  db: Database,
  opts: SearchOptions,
  deps: SearchDeps = {}
): Promise<SearchResponse> {
  const queryTimeoutMs = deps.queryTimeoutMs ?? 3_000;
  if (!Number.isFinite(queryTimeoutMs) || queryTimeoutMs <= 0) {
    throw new Error("queryTimeoutMs must be a positive finite number");
  }
  if (opts.now && Number.isNaN(opts.now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  assertSearchOptions(opts);
  const limit = opts.limit ?? 20;
  const mode = opts.mode ?? "hybrid";
  const warnings: string[] = [];

  // No query: delegate to filter search
  if (!opts.query) {
    return { results: filterSearch(db, opts), warnings };
  }

  const query = opts.query;
  let ftsResults: SearchResult[] | null = null;
  let vecResults: SearchResult[] | null = null;

  // A date sort picks the `limit` results by date, not by score, so each lane
  // retrieves a wider pool first. The full-text lane takes its best
  // dateSortPool(limit) documents. The vector lane takes the documents behind
  // its nearest chunks, up to dateSortPool(limit) documents and never more
  // than the 500-chunk KNN ceiling. The fused pool is date-sorted, then cut to
  // `limit`; a match outside the pool is not considered.
  const dateSorted = opts.sort === "updated" || opts.sort === "deadline";
  const pool = dateSortPool(limit);
  const laneOpts: SearchOptions = dateSorted ? { ...opts, limit: pool } : opts;

  // FTS search
  if (mode === "fts" || mode === "hybrid") {
    try {
      ftsResults = dateSorted ? ftsSearch(db, query, opts, pool) : ftsSearch(db, query, opts);
    } catch (e) {
      // FTS might fail on malformed queries; treat as empty results
      warnings.push(`FTS search failed: ${(e as Error).message}`);
      if (mode === "fts") return { results: [], warnings };
    }
  }

  // Vector search
  if (mode === "vector" || mode === "hybrid") {
    const degraded = mode === "hybrid" ? "; results are FTS-only" : "";
    const embeddings = deps.embeddings;
    if (!hasVecSupport(db)) {
      warnings.push(`vector search unavailable: sqlite-vec extension not loaded${degraded}`);
    } else if (!embeddings) {
      warnings.push(`vector search unavailable: no embedding provider configured${degraded}`);
    } else if (!embeddingIdentityMatches(getMeta(db, "embedding_model"), embeddings.id)) {
      // Stored vectors were produced by a different model than the one that
      // would embed this query — ranking across mixed vector spaces is
      // silently wrong, so skip instead. The next index run wipes the stale
      // vectors; the next --embeddings run rebuilds them.
      warnings.push(
        `vector search skipped: stored vectors were produced by ` +
          `'${getMeta(db, "embedding_model") ?? "unknown"}' but the current model is ` +
          `'${embeddings.id}' — run 'brain index --embeddings' to rebuild them${degraded}`
      );
    } else if (!vecStoreHasRows(db)) {
      warnings.push(
        `vector search unavailable: no stored vectors — run 'brain index --embeddings'${degraded}`
      );
    } else {
      try {
        vecResults = await vectorSearch(db, query, laneOpts, embeddings, queryTimeoutMs);
      } catch (e) {
        warnings.push(`vector search failed: ${(e as Error).message}${degraded}`);
      }
    }
    if (mode === "vector" && vecResults === null) {
      return { results: [], warnings };
    }
  }

  // No results from any source
  if (ftsResults === null && vecResults === null) {
    return { results: [], warnings };
  }

  // Merge or use single source. FTS goes first, so a document both lanes
  // found keeps its FTS snippet.
  let candidates: SearchResult[];
  if (ftsResults !== null && vecResults !== null) {
    candidates = weightedRankFusion([
      { results: ftsResults, weight: ftsLaneWeight(ftsResults.length, limit) },
      { results: vecResults, weight: VECTOR_LANE_WEIGHT },
    ]);
  } else {
    candidates = (ftsResults ?? vecResults)!;
  }

  // Rerank pass, in every mode. Raw cosine scores are tightly packed, so
  // multiplying them by lifecycle factors would re-sort the list (an earlier
  // eval measured vector MRR@10 falling from 0.805 to 0.659 that way). In
  // vector mode the factors multiply a rank-derived score, 1/(RRF_K + rank),
  // instead: the scale hybrid's fused scores already have, where a factor
  // nudges a document a few places rather than across the list.
  const rerankMode = opts.rerank ?? getDefaultRerankerMode();
  // Every non-empty set, one result included, so a result's score does not
  // change scale with how many others came back.
  if (rerankMode !== "none" && candidates.length > 0) {
    if (mode === "vector") {
      candidates = candidates.map((result, i) => ({ ...result, score: 1 / (RRF_K + i + 1) }));
    }
    candidates = rerank(query, candidates, { mode: rerankMode, now: opts.now, taxonomy: deps.taxonomy });
  }
  if (opts.sort === "updated" || opts.sort === "deadline") {
    candidates = sortByDate(db, candidates, opts.sort);
  }

  return { results: candidates.slice(0, limit), warnings };
}

/** How many query matches each lane retrieves before a date sort. */
function dateSortPool(limit: number): number {
  return Math.max(limit * 20, 500);
}

/**
 * Reorder ranked candidates by a date, validated in SQL the same way the
 * filters validate it and compared as an exact instant (julianday keeps
 * fractional seconds), with a missing or malformed date last. The sort is
 * stable, so documents with the same instant keep their ranked order.
 */
function sortByDate(db: Database, candidates: SearchResult[], sort: "updated" | "deadline"): SearchResult[] {
  if (candidates.length === 0) return candidates;
  const placeholders = candidates.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT d.path AS path, ${DATE_SORT_KEY[sort]} AS day FROM documents d WHERE d.path IN (${placeholders})`)
    .all(...candidates.map((r) => r.path)) as { path: string; day: number | null }[];
  const keys = new Map(rows.map((r) => [r.path, r.day]));
  const direction = sort === "updated" ? -1 : 1;
  return [...candidates].sort((a, b) => {
    const left = keys.get(a.path) ?? null;
    const right = keys.get(b.path) ?? null;
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left < right ? -1 : 1) * direction;
  });
}
