import { Database } from "bun:sqlite";

import { SEARCH_SORTS, type ChunkMatch, type SearchResult, type SearchOptions } from "./types.js";
import type { EmbeddingProvider } from "./seams.js";
import type { Taxonomy } from "./taxonomy.js";
import { hasVecSupport, getMeta, embeddingIdentityMatches, hasDocumentsColumn } from "./db.js";
import { nameKey } from "./name-key.js";
import { rerank, getDefaultRerankerMode } from "./reranker.js";
import { ftsIsEnglish } from "./search-language.js";
import { SUPERSEDED_FACTOR } from "./supersedes.js";

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

/** `documents.generated_from`, or NULL on a schema-9 index a read-only connection has not migrated. */
function generatedFromColumn(db: Database): string {
  return hasDocumentsColumn(db, "generated_from") ? "d.generated_from" : "NULL";
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
      d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline, ${generatedFromColumn(db)} AS generatedFrom,
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
 * match the `porter unicode61` tokenizer, which stems English only; an index
 * built for `search.language: none` gets no stopwords at all.
 */
export const FTS_STOPWORDS = new Set([
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
function sanitizeFtsQuery(query: string, stopwords: boolean): string {
  // FTS5 escapes a quote inside a phrase by doubling it: `"a ""b"""`.
  const phrase = /^\s*"((?:[^"]|"")+)"\s*$/.exec(query);
  if (phrase) return quoteFtsTerm(phrase[1]!.replace(/""/g, '"').trim());

  const tokens = query.split(/\s+/).filter(Boolean);
  // A token with no letter or digit (`?`, `-`) is an empty phrase: FTS5's AND
  // skips it, but alone in an OR it matches nothing, so it is not a content term.
  const content = tokens.filter((token) => {
    const word = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    return word !== "" && !(stopwords && FTS_STOPWORDS.has(word));
  });
  if (content.length === 0) return tokens.map(quoteFtsTerm).join(" ");
  return [...new Set(content.map(quoteFtsTerm))].join(" OR ");
}

/** Whether the index has the chunk full-text table (schema 13 and later). */
function hasChunksFts(db: Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get() !== null;
}

type FtsRow = Omit<SearchResult, "chunks">;

/** Whether `documents_fts` has its own aliases column (schema 14 and later). */
function hasAliasesColumn(db: Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'").get() as
    | { sql: string }
    | null;
  return !!row && /\baliases\b/.test(row.sql);
}


/**
 * A query that is, case-folded with its spacing collapsed, a document's exact
 * title or one of its aliases names that document: it goes first, whatever
 * the lanes scored. The named documents are looked up by that key in
 * `name_keys` (an indexed lookup, schema 14), under the search's filters, so
 * one the score-limited lanes left out, or that the tokenizer does not match
 * (`STRASSE` for `Straße`), is still found. Several keep their ranked order
 * among themselves, a named one the lanes missed after those, by path, all
 * ahead of the rest; a missed one carries `supersededBy` like any result. An
 * index from before schema 14 has no `name_keys`: only the ranked candidates
 * are compared there.
 */
function promoteExactNames(db: Database, query: string, candidates: SearchResult[], opts: SearchOptions): SearchResult[] {
  const key = nameKey(query);
  if (!key) return candidates;
  let named: Set<string>;
  if (hasNameKeys(db)) {
    const filters = buildFilters(opts);
    named = new Set(
      (
        db
          .prepare(
            `SELECT d.path AS path FROM name_keys k JOIN documents d ON d.id = k.document_id
             WHERE k.key = ? ${filters.where}`
          )
          .all(key, ...filters.params) as { path: string }[]
      ).map((row) => row.path)
    );
  } else {
    const titles = new Map(candidates.map((r) => [r.path, r.title]));
    named = new Set([...titles].filter(([, title]) => nameKey(title) === key).map(([path]) => path));
  }
  if (named.size === 0) return candidates;
  const ranked = new Set(candidates.map((r) => r.path));
  const missing = [...named].filter((path) => !ranked.has(path)).sort();
  const fetched =
    missing.length === 0
      ? []
      : markSuperseded(
          db,
          (
            db
              .prepare(
                `SELECT ${ftsDocColumns(db)}, d.content AS content
                 FROM documents d WHERE d.path IN (${missing.map(() => "?").join(",")})`
              )
              .all(...missing) as Array<SearchResult & { content: string }>
          )
            .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
            .map(({ content, ...row }) => ({ ...row, score: 0, snippet: makeSnippet(content) }))
        );
  return [...candidates.filter((r) => named.has(r.path)), ...fetched, ...candidates.filter((r) => !named.has(r.path))];
}

/** Whether the index has the exact-name lookup table (schema 14 and later). */
function hasNameKeys(db: Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'name_keys'").get() !== null;
}

/** The document fields a full-text row carries, as SQL. */
function ftsDocColumns(db: Database): string {
  return `
  d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline, ${generatedFromColumn(db)} AS generatedFrom,
  (SELECT GROUP_CONCAT(t.name, ', ')
   FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
   WHERE dt.document_id = d.id) as tags`;
}

/**
 * Full-text search using FTS5, over two tables.
 *
 * - `documents_fts`, restricted to a document's title, summary, tags and
 *   aliases (bm25 weights 5, 3, 2 and 5, an alias counting like the title):
 *   what the document is called and about.
 * - `chunks_fts`, over each chunk's heading and body (weights 2 and 1): where
 *   in the document the words are. A long document is ranked by its best
 *   section, not diluted by BM25's length normalisation over its whole body.
 *
 * A document's score is the better of its two BM25 scores (its best chunk's,
 * for the chunk table), and its snippet comes from its best-matching chunk
 * when a chunk matched, else from the document row as before. A document
 * that matches only on its whole-document row ranks after all of those (see
 * below). An index from before schema 13 has no chunk table and is searched
 * on its whole-document row alone, as it always was.
 */
function ftsSearch(
  db: Database,
  query: string,
  opts: SearchOptions,
  candidates = (opts.limit ?? 20) * 2
): SearchResult[] {
  // Stopwords follow the index: English ones only for an English (Porter)
  // index, so a query and the text it searches are read the same way. The
  // tokenizer is read and every query run in one read transaction, so a
  // rebuild committing in between cannot pair one table's stopwords with the
  // other table.
  return db.transaction(() => ftsSearchInSnapshot(db, query, opts, candidates))();
}

function ftsSearchInSnapshot(db: Database, query: string, opts: SearchOptions, candidates: number): SearchResult[] {
  const filters = buildFilters(opts);
  const match = sanitizeFtsQuery(query, ftsIsEnglish(db));
  const columns = ftsDocColumns(db);

  // bm25() returns negative values (better = more negative), hence the
  // negation for score and ascending ORDER BY.
  // Column weights: title, summary, content, tags, aliases. An index from
  // before schema 14 has no aliases column; the extra weight is ignored there.
  const wholeDocument = (expression: string, limit: number) =>
    db
      .prepare(
        `SELECT ${columns},
           -bm25(documents_fts, 5.0, 3.0, 1.0, 2.0, 5.0) as score,
           snippet(documents_fts, 2, '>>>', '<<<', '...', 40) as snippet
         FROM documents_fts fts
         JOIN documents d ON d.id = fts.rowid
         WHERE documents_fts MATCH ? ${filters.where}
         ORDER BY bm25(documents_fts, 5.0, 3.0, 1.0, 2.0, 5.0)
         LIMIT ?`
      )
      .all(expression, ...filters.params, limit) as SearchResult[];
  if (!hasChunksFts(db)) return wholeDocument(match, candidates);

  const byDocument = db
    .prepare(
      `SELECT ${columns},
         -bm25(documents_fts, 5.0, 3.0, 0.0, 2.0, 5.0) as score,
         snippet(documents_fts, 2, '>>>', '<<<', '...', 40) as snippet
       FROM documents_fts fts
       JOIN documents d ON d.id = fts.rowid
       WHERE documents_fts MATCH ? ${filters.where}
       ORDER BY bm25(documents_fts, 5.0, 3.0, 0.0, 2.0, 5.0)
       LIMIT ?`
    )
    .all(`{${hasAliasesColumn(db) ? "title summary tags aliases" : "title summary tags"}} : (${match})`, ...filters.params, candidates) as FtsRow[];

  // Each document's best chunk, chosen over every matching chunk before the
  // document limit applies: a document whose best section is strong is not
  // pushed out by another document owning many good ones. bm25() cannot run
  // under a window function, so it is scored in a materialized CTE first.
  const byChunk = db
    .prepare(
      `WITH hits AS MATERIALIZED (
         SELECT cf.rowid AS chunk_id, bm25(chunks_fts, 2.0, 1.0) AS rank
         FROM chunks_fts cf WHERE chunks_fts MATCH ?
       )
       SELECT ${columns}, best.chunk_id AS chunkId, -best.rank AS score
       FROM (
         SELECT c.document_id AS doc_id, hits.chunk_id, hits.rank,
                ROW_NUMBER() OVER (PARTITION BY c.document_id ORDER BY hits.rank, hits.chunk_id) AS nth
         FROM hits JOIN chunks c ON c.id = hits.chunk_id
       ) best
       JOIN documents d ON d.id = best.doc_id
       WHERE best.nth = 1 ${filters.where}
       ORDER BY best.rank, d.path
       LIMIT ?`
    )
    .all(match, ...filters.params, candidates) as Array<FtsRow & { chunkId: number }>;

  const best = new Map<string, FtsRow & { chunkId?: number }>();
  for (const row of byChunk) best.set(row.path, row);
  for (const row of byDocument) {
    const seen = best.get(row.path);
    if (!seen) best.set(row.path, row);
    // The better score wins; a chunk that matched keeps the snippet.
    else if (row.score > seen.score) best.set(row.path, { ...seen, score: row.score });
  }
  const ranked = [...best.values()]
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, candidates);
  chunkSnippets(db, match, ranked);

  // A document whose terms all match only across its sections (an AND of
  // stopwords, a phrase over a chunk boundary), or that has no chunks, is
  // still found by its whole-document row. It ranks after every document
  // found in one place, in that row's order: its scores are scaled under the
  // lowest score above it, and it is marked, so the rerank keeps it there
  // whatever the lifecycle factors say (see hybridSearch).
  if (ranked.length >= candidates) return ranked as SearchResult[];
  const found = new Set(ranked.map((row) => row.path));
  const acrossSections = (wholeDocument(match, candidates) as FtsRow[]).filter((row) => !found.has(row.path));
  const floor = ranked.at(-1)?.score;
  const top = acrossSections[0]?.score ?? 0;
  const below = acrossSections.map((row) => ({
    ...row,
    score: floor === undefined || top <= 0 ? row.score : (row.score / top) * floor * 0.5,
    [ACROSS_SECTIONS]: true,
  }));
  return [...ranked, ...below].slice(0, candidates) as SearchResult[];
}

/**
 * Marks a full-text result found only on its whole-document row. A symbol
 * key: it survives the reranker's object spread and never reaches JSON.
 */
const ACROSS_SECTIONS = Symbol("acrossSections");

/**
 * Fill in each ranked document's snippet from its best-matching chunk: the
 * one the chunk lane chose, or, for a document that came in on its title,
 * summary or tags, its best chunk that matches at all. A document with no
 * matching chunk keeps its document-row snippet.
 */
function chunkSnippets(db: Database, match: string, ranked: Array<FtsRow & { chunkId?: number }>): void {
  const needBest = ranked.filter((row) => row.chunkId === undefined).map((row) => row.path);
  if (needBest.length > 0) {
    const placeholders = needBest.map(() => "?").join(",");
    const rows = db
      .prepare(
        `WITH hits AS MATERIALIZED (
           SELECT cf.rowid AS chunk_id, bm25(chunks_fts, 2.0, 1.0) AS rank
           FROM chunks_fts cf WHERE chunks_fts MATCH ?
         )
         SELECT path, chunk_id FROM (
           SELECT d.path AS path, hits.chunk_id,
                  ROW_NUMBER() OVER (PARTITION BY d.id ORDER BY hits.rank, hits.chunk_id) AS nth
           FROM hits JOIN chunks c ON c.id = hits.chunk_id JOIN documents d ON d.id = c.document_id
           WHERE d.path IN (${placeholders})
         ) WHERE nth = 1`
      )
      .all(match, ...needBest) as { path: string; chunk_id: number }[];
    const byPath = new Map(rows.map((r) => [r.path, r.chunk_id]));
    for (const row of ranked) if (row.chunkId === undefined && byPath.has(row.path)) row.chunkId = byPath.get(row.path);
  }
  const ids = ranked.map((row) => row.chunkId).filter((id): id is number => id !== undefined);
  if (ids.length === 0) return;
  const snippets = new Map(
    (
      db
        .prepare(
          `SELECT rowid AS id, snippet(chunks_fts, 1, '>>>', '<<<', '...', 40) AS snippet
           FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${ids.map(() => "?").join(",")})`
        )
        .all(match, ...ids) as { id: number; snippet: string }[]
    ).map((r) => [r.id, r.snippet])
  );
  for (const row of ranked) {
    const snippet = row.chunkId === undefined ? undefined : snippets.get(row.chunkId);
    if (snippet !== undefined) row.snippet = snippet;
    // Every result carries a snippet; this is reached only if the chunk went
    // missing, which the caller's read snapshot rules out.
    row.snippet ??= "";
    delete row.chunkId;
  }
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
        d.path, d.title, d.type, d.relevance, d.status, d.summary, d.updated, d.deadline, ${generatedFromColumn(db)} AS generatedFrom,
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
      generatedFrom: string | null;
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
          generatedFrom: row.generatedFrom,
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

  // No query: delegate to filter search. With nothing to match, a result's
  // chunks are an empty list.
  if (!opts.query) {
    const results = markSuperseded(db, filterSearch(db, opts));
    return { results: opts.chunks ? results.map((r) => ({ ...r, chunks: [] })) : results, warnings };
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
  candidates = demoteSuperseded(db, candidates);
  // A full-text result found only across its sections stays after every one
  // found in one place: its tier comes before its reranked score. That holds
  // whenever the ranking came from full text alone: `fts` mode, or `hybrid`
  // with no vector contribution (no extension, no provider, no stored
  // vectors, a failed embedding call, no vector hits). With vector hits the
  // fused rank decides.
  if (ftsResults !== null && (vecResults === null || vecResults.length === 0)) {
    candidates = [...candidates].sort((a, b) => Number(ACROSS_SECTIONS in a) - Number(ACROSS_SECTIONS in b));
  }
  if (mode !== "vector") candidates = promoteExactNames(db, query, candidates, opts);
  if (opts.sort === "updated" || opts.sort === "deadline") {
    candidates = sortByDate(db, candidates, opts.sort);
  }

  const results = candidates.slice(0, limit);
  return { results: opts.chunks ? withChunks(db, results, query, warnings) : results, warnings };
}

/**
 * Each result with its chunks that match the query, best first, read as the
 * full-text lane reads it: the same MATCH expression over `chunks_fts`, so
 * the same tokenizer (stemming, case and accent folding, `search.language`)
 * and the same stopwords. A chunk matches when it holds a query term; its
 * score is its BM25 relevance (heading weight 2, content 1), negated so that
 * higher is better, and ties go to document order. A result with no matching
 * chunk (a vector-only match), every result of a query with no word to match
 * (whitespace or punctuation alone), and every result on an index from before
 * the chunk table (schema 12), gets an empty list. Matching that fails is
 * treated like a failed lane: the results stand, each with an empty list, and
 * `warnings` says why.
 */
function withChunks(db: Database, results: SearchResult[], query: string, warnings: string[]): SearchResult[] {
  if (results.length === 0) return results;
  const none = () => results.map((r) => ({ ...r, chunks: [] as ChunkMatch[] }));
  if (!hasLexicalTerm(query) || !hasChunksFts(db)) return none();
  let rows: ChunkMatch[];
  try {
    // The tokenizer is read and the query run in one read transaction, as ftsSearch does.
    rows = db.transaction(() => {
      const match = sanitizeFtsQuery(query, ftsIsEnglish(db));
      return db
        .prepare(
          `SELECT d.path, c.chunk_index, c.heading, c.content, -bm25(chunks_fts, 2.0, 1.0) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN documents d ON d.id = c.document_id
           WHERE chunks_fts MATCH ? AND d.path IN (${results.map(() => "?").join(",")})
           ORDER BY d.path, score DESC, c.chunk_index`
        )
        .all(match, ...results.map((r) => r.path)) as ChunkMatch[];
    })();
  } catch (e) {
    warnings.push(`chunk matching failed: ${(e as Error).message}`);
    return none();
  }
  const byPath = new Map<string, ChunkMatch[]>();
  for (const row of rows) byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
  return results.map((result) => ({ ...result, chunks: byPath.get(result.path) ?? [] }));
}

/** Whether a query has a letter or digit for the full-text match to look for. */
function hasLexicalTerm(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}

/**
 * Where in one chunk the query first matches, as the full-text lane reads it:
 * the chunk's content line holding the first highlighted term, trimmed. Null
 * when the query matches only the chunk's heading, or not at all, or when the
 * chunk index cannot answer (no chunk table, a query with no word, a failure).
 * `brain context` uses it to tell which source section of a chunk the chunker
 * folded together holds the match.
 */
export function chunkMatchLine(db: Database, query: string, path: string, chunkIndex: number): string | null {
  if (!hasLexicalTerm(query) || !hasChunksFts(db)) return null;
  try {
    const row = db.transaction(() => {
      const match = sanitizeFtsQuery(query, ftsIsEnglish(db));
      return db
        .prepare(
          `SELECT highlight(chunks_fts, 1, char(1), char(2)) AS marked
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN documents d ON d.id = c.document_id
           WHERE chunks_fts MATCH ? AND d.path = ? AND c.chunk_index = ?`
        )
        .get(match, path, chunkIndex) as { marked: string } | null;
    })();
    const marked = row?.marked;
    const at = marked?.indexOf("\u0001") ?? -1;
    if (!marked || at === -1) return null;
    const start = marked.lastIndexOf("\n", at) + 1;
    const end = marked.indexOf("\n", at);
    const line = marked.slice(start, end === -1 ? marked.length : end).replace(/[\u0001\u0002]/g, "").trim();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * A document another one `supersedes` (#412) is demoted, not hidden: its score
 * is multiplied by SUPERSEDED_FACTOR and it carries `supersededBy`, the path
 * of the document that replaces it (the first by path when several do). It
 * runs after fusion and reranking, in every mode and with `rerank: none`, so
 * no mode ranks a replaced document on equal terms with its replacement. An
 * index from before schema 12 has no `supersedes` table and is left as it is.
 */
function demoteSuperseded(db: Database, candidates: SearchResult[]): SearchResult[] {
  const supersededBy = supersededByOf(db, candidates);
  if (supersededBy.size === 0) return candidates;
  return candidates
    .map((result) => {
      const by = supersededBy.get(result.path);
      return by ? { ...result, score: result.score * SUPERSEDED_FACTOR, supersededBy: by } : result;
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * A filter-only search's results with `supersededBy` set on each superseded
 * one. Nothing is demoted: a filter has no ranking, and its date order stays.
 */
function markSuperseded(db: Database, results: SearchResult[]): SearchResult[] {
  const supersededBy = supersededByOf(db, results);
  if (supersededBy.size === 0) return results;
  return results.map((result) => {
    const by = supersededBy.get(result.path);
    return by ? { ...result, supersededBy: by } : result;
  });
}

/**
 * For each result another document supersedes, that document's path (the
 * first by path when several do). Empty on an index from before schema 12,
 * which has no `supersedes` table.
 */
function supersededByOf(db: Database, results: SearchResult[]): Map<string, string> {
  if (results.length === 0) return new Map();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supersedes'").get() !== null;
  if (!hasTable) return new Map();
  const placeholders = results.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT old.path AS path, MIN(new.path) AS by
       FROM supersedes s
       JOIN documents old ON old.id = s.target_id
       JOIN documents new ON new.id = s.source_id
       WHERE old.path IN (${placeholders})
       GROUP BY old.path`
    )
    .all(...results.map((r) => r.path)) as { path: string; by: string }[];
  return new Map(rows.map((row) => [row.path, row.by]));
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
