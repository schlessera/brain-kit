import { Database } from "bun:sqlite";

import type { SearchResult, SearchOptions } from "./types.js";
import type { EmbeddingProvider } from "./seams.js";
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
  /** Interactive vector budget; must finish before the UI CLI deadline. */
  queryTimeoutMs?: number;
}

interface FilterResult {
  where: string;
  params: any[];
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

  return {
    where: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
  };
}

/**
 * Filter-only search (no query text). Returns documents matching filters,
 * ordered by updated date descending.
 */
export function filterSearch(db: Database, opts: SearchOptions): SearchResult[] {
  const limit = opts.limit ?? 20;
  const filters = buildFilters(opts);

  const sql = `
    SELECT
      d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated,
      (SELECT GROUP_CONCAT(t.name, ', ')
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id = d.id) as tags,
      0 as score,
      '' as snippet
    FROM documents d
    WHERE 1=1 ${filters.where}
    ORDER BY d.updated DESC
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
  const phrase = /^\s*"([^"]+)"\s*$/.exec(query);
  if (phrase) return quoteFtsTerm(phrase[1]!.trim());

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
  opts: SearchOptions
): SearchResult[] {
  const limit = opts.limit ?? 20;
  const filters = buildFilters(opts);
  query = sanitizeFtsQuery(query);

  // bm25() column weights: title 5x, summary 3x, content 1x, tags 2x —
  // frontmatter fields carry far more signal per token than body text.
  // bm25() returns negative values (better = more negative), hence the
  // negation for score and ascending ORDER BY.
  const sql = `
    SELECT
      d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated,
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

  const params = [query, ...filters.params, limit * 2];
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
  // assets filters run post-KNN, so widen the candidate window when they are
  // present or filtering starves the result set.
  const hasPostFilters = !!(opts.tag || opts.relevance || opts.status || opts.assetsOnly);
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
        d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated,
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

/**
 * Merge result lists using Reciprocal Rank Fusion (RRF).
 * score(d) = sum(1 / (60 + rank)) where rank is 1-indexed position in each list.
 */
function reciprocalRankFusion(
  ...resultLists: SearchResult[][]
): SearchResult[] {
  const scoreMap = new Map<string, { score: number; result: SearchResult }>();

  for (const results of resultLists) {
    for (let i = 0; i < results.length; i++) {
      const rank = i + 1;
      const rrfScore = 1 / (60 + rank);
      const key = results[i].path;

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, {
          score: rrfScore,
          result: results[i],
        });
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
  const limit = opts.limit ?? 20;
  const mode = opts.mode ?? "hybrid";
  const warnings: string[] = [];

  // No query: delegate to filter search
  if (!opts.query) {
    return { results: filterSearch(db, opts), warnings };
  }

  const query = opts.query;
  const resultLists: SearchResult[][] = [];

  // FTS search
  if (mode === "fts" || mode === "hybrid") {
    try {
      const ftsResults = ftsSearch(db, query, opts);
      resultLists.push(ftsResults);
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
        const vecResults = await vectorSearch(db, query, opts, embeddings, queryTimeoutMs);
        resultLists.push(vecResults);
      } catch (e) {
        warnings.push(`vector search failed: ${(e as Error).message}${degraded}`);
      }
    }
    if (mode === "vector" && resultLists.length === 0) {
      return { results: [], warnings };
    }
  }

  // No results from any source
  if (resultLists.length === 0) {
    return { results: [], warnings };
  }

  // Merge or use single source
  let candidates: SearchResult[];
  if (resultLists.length === 1) {
    candidates = resultLists[0];
  } else {
    candidates = reciprocalRankFusion(...resultLists);
  }

  // Rerank pass — but never on pure-vector results: raw cosine scores are
  // tightly packed, so the heuristic's multiplicative recency/relevance
  // factors overwhelm them (eval 2026-07-04: vector MRR@10 0.805 → 0.659
  // with reranking). On hybrid's RRF scores the same heuristic is net
  // positive (hit@1 0.370 → 0.481), so it stays for fts/hybrid.
  const rerankMode = opts.rerank ?? getDefaultRerankerMode();
  if (rerankMode !== "none" && mode !== "vector" && candidates.length > 1) {
    candidates = rerank(query, candidates, { mode: rerankMode, now: opts.now });
  }

  return { results: candidates.slice(0, limit), warnings };
}
