/**
 * PRIVATE prototype of a bounded multi-query search for the #3645 spike.
 * Not exported from any package, not a registered MCP or Pi tool, not a
 * contract. The harness (`../multi-query-search.test.ts`) measures it against
 * parallel single-query `brain_search` calls.
 *
 * Every query runs through the same ranking `brain_search` uses: the
 * reranker selection and option mapping of (`searchDocuments`,
 * `packages/core/src/lib/ops/read.ts:59-106`) over `hybridSearch`. The only
 * addition is a #3644 path scope, pushed into the candidate pool through
 * `SearchOptions.paths` exactly as `assembleContext` pushes it, so a scoped
 * query ranks the scope's documents rather than filtering a cut list.
 *
 * Sizes are UTF-16 code units of the serialized JSON result, the unit of the
 * #3641 contract (`JSON.stringify(result).length`).
 */
import type { Database } from "bun:sqlite";

import { parseContextScope, type ContextScope } from "../../packages/core/src/lib/context-scope.ts";
import type { ReadDeps } from "../../packages/core/src/lib/ops/read.ts";
import { rerankSetup } from "../../packages/core/src/lib/registry.ts";
import { hybridSearch } from "../../packages/core/src/lib/search-engine.ts";
import type { SearchOptions } from "../../packages/core/src/lib/types.ts";
import type { NamedQuery } from "./workload.ts";

export const MAX_QUERIES = 8;
export const MAX_QUERY_LIMIT = 50;
export const DEFAULT_QUERY_LIMIT = 10;
export const DEFAULT_TOTAL_RESULTS = 50;
export const MAX_TOTAL_RESULTS = 200;
export const DEFAULT_TOTAL_CHARS = 24_000;
export const MIN_TOTAL_CHARS = 2_000;
export const MAX_TOTAL_CHARS = 40_000;
const MAX_ID_CHARS = 64;

export interface SearchManyInput {
  queries: NamedQuery[];
  max_total_results?: number;
  max_total_chars?: number;
  /** `documents`: query-independent fields once per path; `none`: every hit carries them, as `brain_search` rows do. */
  dedupe?: "none" | "documents";
}

/** The query-independent fields of a `brain_search` row. */
export interface DocumentFields {
  title: string;
  type: string;
  relevance: string | null;
  status: string | null;
  summary: string | null;
  updated: string | null;
  deadline: string | null;
  tags: string | null;
  supersededBy?: string;
}

/** One hit of one query: its own rank and its own score, never another query's. */
export interface Hit { rank: number; path: string; score: number | null; snippet: string | null }
export type FullHit = Hit & DocumentFields;

export type QueryItem =
  | {
      index: number; id: string; status: "ok";
      hits: Array<Hit | FullHit>;
      returned: number;
      /** Hits the search ranked but the call's budget left out. */
      omitted: number;
      /** The search returned its full limit: more matches may exist. */
      limit_reached: boolean;
      /** Indices into the call's `warnings`. */
      warnings?: number[];
    }
  | { index: number; id: string; status: "duplicate"; of: number }
  | { index: number; id: string; status: "error"; code: "invalid_query" | "search_failed"; message: string };

export interface SearchManyResult {
  queries: QueryItem[];
  documents?: Record<string, DocumentFields>;
  truncated: boolean;
  max_total_results: number;
  max_total_chars: number;
  warnings: string[];
}

export class SearchManyRequestError extends Error {}

/** What the call did, for the harness. */
export interface SearchManyWork {
  searches: number;
  /** Queries whose mode asks for the vector lane (hybrid or vector). Whether it ran is in the warnings. */
  vectorLaneRequested: number;
}

export interface SearchManyOptions {
  signal?: AbortSignal;
  work?: SearchManyWork;
  /** How the char budget is shared: `fair` round-robin by rank (the proposal), or `sequential` in query order. */
  strategy?: "fair" | "sequential";
  /** Run every query in one read transaction (default true). */
  snapshot?: boolean;
  /** Called between queries inside the snapshot; harness seam for snapshot tests. */
  between?: (index: number) => void;
}

const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Structural checks: a failure rejects the whole call, never clamps it. */
function validate(input: SearchManyInput): void {
  const q = input.queries;
  if (!Array.isArray(q) || q.length < 1 || q.length > MAX_QUERIES) throw new SearchManyRequestError(`queries must hold 1 to ${MAX_QUERIES} entries`);
  const ids = new Set<string>();
  for (const [i, entry] of q.entries()) {
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(entry.id)) throw new SearchManyRequestError(`queries[${i}].id must be 1 to ${MAX_ID_CHARS} of A-Z a-z 0-9 _ . -`);
    if (ids.has(entry.id)) throw new SearchManyRequestError(`queries[${i}].id ${JSON.stringify(entry.id)} repeats an earlier id`);
    ids.add(entry.id);
    if (typeof entry.query !== "string" || entry.query.length > 1_024) throw new SearchManyRequestError(`queries[${i}].query must be a string of at most 1024 chars`);
    if (entry.limit !== undefined && !intIn(entry.limit, 1, MAX_QUERY_LIMIT)) throw new SearchManyRequestError(`queries[${i}].limit must be an integer from 1 to ${MAX_QUERY_LIMIT}`);
  }
  if (input.max_total_results !== undefined && !intIn(input.max_total_results, 1, MAX_TOTAL_RESULTS)) throw new SearchManyRequestError(`max_total_results must be an integer from 1 to ${MAX_TOTAL_RESULTS}`);
  if (input.max_total_chars !== undefined && !intIn(input.max_total_chars, MIN_TOTAL_CHARS, MAX_TOTAL_CHARS)) throw new SearchManyRequestError(`max_total_chars must be an integer from ${MIN_TOTAL_CHARS} to ${MAX_TOTAL_CHARS}`);
}

/** The fields that decide a query's answer; equal keys are duplicates whatever their ids. */
function queryKey(q: NamedQuery): string {
  const { id: _id, ...rest } = q;
  const norm: Record<string, unknown> = { ...rest, limit: rest.limit ?? DEFAULT_QUERY_LIMIT, mode: rest.mode ?? "hybrid" };
  if (norm.include_archived === false) delete norm.include_archived;
  return JSON.stringify(Object.keys(norm).sort().map(k => [k, norm[k]]));
}

/** The indexed paths a scoped query may return, as `assembleContext`'s `scopedPaths` draws them. */
function scopedPaths(db: Database, scope: ContextScope): NonNullable<SearchOptions["paths"]> {
  const paths = (db.prepare("SELECT path FROM documents").all() as Array<{ path: string }>).map(r => r.path);
  return scope.include ? { allow: paths.filter(p => scope.allows(p)) } : { deny: paths.filter(p => scope.excludes(p)) };
}

/** One query as `brain_search` runs it, plus an optional pushed-down scope. */
async function runQuery(deps: ReadDeps, q: NamedQuery, scope: ContextScope | null): Promise<{ hits: FullHit[]; warnings: string[] }> {
  const setup = rerankSetup(deps.brain.config?.reranker, undefined);
  const opts: SearchOptions = {
    query: q.query,
    mode: q.mode ?? "hybrid",
    rerank: setup.rerank,
    type: q.type, tag: q.tag, relevance: q.relevance,
    includeArchived: q.include_archived ?? false,
    assetsOnly: false,
    limit: q.limit ?? DEFAULT_QUERY_LIMIT,
    updatedSince: q.updated_since, updatedBefore: q.updated_before,
    deadlineFrom: q.deadline_from, deadlineTo: q.deadline_to,
    sort: q.sort,
    ...(scope ? { paths: scopedPaths(deps.db, scope) } : {}),
  };
  const { results, warnings } = await hybridSearch(deps.db, opts, {
    embeddings: deps.embeddings,
    taxonomy: deps.brain.taxonomy,
    ...setup.deps,
  });
  if (setup.warning) warnings.unshift(setup.warning);
  return {
    hits: results.map((r, i) => ({
      rank: i + 1, path: r.path, score: r.score ?? null, snippet: r.snippet ?? null,
      title: r.title, type: r.type, relevance: r.relevance ?? null, status: r.status ?? null, summary: r.summary ?? null,
      updated: r.updated ?? null, deadline: r.deadline ?? null, tags: r.tags ?? null,
      ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
    })),
    warnings,
  };
}

const splitHit = (h: FullHit): { hit: Hit; doc: DocumentFields } => {
  const { rank, path, score, snippet, ...doc } = h;
  return { hit: { rank, path, score, snippet }, doc };
};

/** Messages never carry a host path: the core error text names only the input. */
const safeMessage = (e: unknown, root: string) => String((e as Error)?.message ?? e).split(root).join("<brain-root>");

export async function searchManyPrototype(deps: ReadDeps, input: SearchManyInput, opts: SearchManyOptions = {}): Promise<SearchManyResult> {
  validate(input);
  const maxChars = input.max_total_chars ?? DEFAULT_TOTAL_CHARS;
  const maxResults = input.max_total_results ?? DEFAULT_TOTAL_RESULTS;
  const dedupe = input.dedupe ?? "documents";
  const work = opts.work ?? { searches: 0, vectorLaneRequested: 0 };
  const signal = opts.signal;

  const warnings: string[] = [];
  const warningIndex = (w: string) => { let i = warnings.indexOf(w); if (i < 0) { warnings.push(w); i = warnings.length - 1; } return i; };
  const seen = new Map<string, number>();
  type Pending = { kind: "ok"; index: number; id: string; all: FullHit[]; limit: number; warnings: number[] } | Exclude<QueryItem, { status: "ok" }>;
  const pending: Pending[] = [];

  const snapshot = opts.snapshot ?? true;
  if (snapshot) deps.db.run("BEGIN");
  try {
    for (const [index, q] of input.queries.entries()) {
      signal?.throwIfAborted();
      const key = queryKey(q);
      const first = seen.get(key);
      if (first !== undefined) { pending.push({ index, id: q.id, status: "duplicate", of: first }); continue; }
      seen.set(key, index);
      let scope: ContextScope | null;
      try { scope = parseContextScope({ include: q.include, exclude: q.exclude }); } catch (e) {
        pending.push({ index, id: q.id, status: "error", code: "invalid_query", message: safeMessage(e, deps.brain.root) });
        continue;
      }
      work.searches++;
      if ((q.mode ?? "hybrid") !== "fts") work.vectorLaneRequested++;
      try {
        const { hits, warnings: w } = await runQuery(deps, q, scope);
        pending.push({ kind: "ok", index, id: q.id, all: hits, limit: q.limit ?? DEFAULT_QUERY_LIMIT, warnings: w.map(warningIndex) });
      } catch (e) {
        // assertSearchOptions throws on an invalid date or sort before any lane runs.
        const message = safeMessage(e, deps.brain.root);
        const invalid = /must be|invalid|unknown sort|YYYY-MM-DD/i.test(message);
        pending.push({ index, id: q.id, status: "error", code: invalid ? "invalid_query" : "search_failed", message });
      }
      opts.between?.(index);
    }
    signal?.throwIfAborted();
  } finally {
    if (snapshot) deps.db.run("COMMIT");
  }

  // The answer, empty, with every count at its widest: the reserve the fill never eats into.
  const items: QueryItem[] = pending.map(p => "kind" in p
    ? { index: p.index, id: p.id, status: "ok" as const, hits: [], returned: 0, omitted: 0, limit_reached: p.all.length >= p.limit, ...(p.warnings.length ? { warnings: p.warnings } : {}) }
    : p);
  const documents: Record<string, DocumentFields> = {};
  const result: SearchManyResult = {
    queries: items, ...(dedupe === "documents" ? { documents } : {}),
    truncated: true, max_total_results: maxResults, max_total_chars: maxChars, warnings,
  };
  const widest = JSON.stringify({ ...result, queries: items.map((it, i) => {
    const p = pending[i]!;
    return "kind" in p && it.status === "ok" ? { ...it, returned: p.all.length, omitted: p.all.length } : it;
  }) }).length;
  if (widest > maxChars) throw new SearchManyRequestError(`max_total_chars ${maxChars} cannot hold the answer's envelope (${widest} chars)`);

  let size = widest, total = 0;
  const live = pending.map(p => ("kind" in p ? { p, next: 0, stopped: false } : null));
  const tryAdd = (slot: NonNullable<(typeof live)[number]>): boolean => {
    const item = items[slot.p.index] as Extract<QueryItem, { status: "ok" }>;
    const full = (slot.p as Extract<Pending, { kind: "ok" }>).all[slot.next]!;
    const { hit, doc } = splitHit(full);
    const entry = dedupe === "documents" ? hit : full;
    let cost = JSON.stringify(entry).length + (item.hits.length > 0 ? 1 : 0);
    const newDoc = dedupe === "documents" && !(full.path in documents);
    if (newDoc) cost += JSON.stringify(full.path).length + 1 + JSON.stringify(doc).length + (Object.keys(documents).length > 0 ? 1 : 0);
    if (total >= maxResults || size + cost > maxChars) return false;
    item.hits.push(entry);
    if (newDoc) documents[full.path] = doc;
    size += cost; total++; slot.next++;
    return true;
  };
  const remaining = (s: NonNullable<(typeof live)[number]>) => !s.stopped && s.next < (s.p as Extract<Pending, { kind: "ok" }>).all.length;
  if ((opts.strategy ?? "fair") === "fair") {
    // Rank 1 of every query, then rank 2, ...; a query stops at its first hit that does not fit, so it returns a prefix.
    for (let progressed = true; progressed;) {
      progressed = false;
      for (const s of live) if (s && remaining(s)) { if (tryAdd(s)) progressed = true; else s.stopped = true; }
    }
  } else {
    for (const s of live) if (s) while (remaining(s)) if (!tryAdd(s)) s.stopped = true;
  }
  for (const s of live) {
    if (!s) continue;
    const item = items[s.p.index] as Extract<QueryItem, { status: "ok" }>;
    item.returned = item.hits.length;
    item.omitted = (s.p as Extract<Pending, { kind: "ok" }>).all.length - item.returned;
  }
  result.truncated = items.some(it => it.status === "ok" && it.omitted > 0);
  return result;
}

/** The (query id, path) pairs an answer attributes, resolving duplicates to the query they point at. */
export function associations(result: SearchManyResult): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const it of result.queries) {
    const src = it.status === "duplicate" ? result.queries[it.of]! : it;
    if (src.status === "ok") for (const h of src.hits) out.push([it.id, h.path]);
  }
  return out;
}

/** A proposed tool definition, for the roster-cost measurement only. */
export const PROPOSED_TOOL = {
  name: "brain_search_many",
  description:
    "Run up to 8 named searches in one call. Each query keeps its own filters, limit, order, rank and score; scores are not comparable across queries. " +
    "Results share one budget (max_total_chars, max_total_results), filled one rank at a time across queries; each query says how many hits were omitted. " +
    "A failing query is an error item; the others still answer. Document fields appear once in `documents`, keyed by path.",
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array", minItems: 1, maxItems: MAX_QUERIES,
        items: {
          type: "object", required: ["id", "query"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" }, query: { type: "string" },
            type: { type: "string" }, tag: { type: "string" }, relevance: { type: "string" },
            mode: { enum: ["fts", "vector", "hybrid"] }, include_archived: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_LIMIT },
            updated_since: { type: "string" }, updated_before: { type: "string" }, deadline_from: { type: "string" }, deadline_to: { type: "string" },
            sort: { enum: ["score", "updated", "deadline"] },
            include: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } },
          },
        },
      },
      max_total_results: { type: "integer", minimum: 1, maximum: MAX_TOTAL_RESULTS },
      max_total_chars: { type: "integer", minimum: MIN_TOTAL_CHARS, maximum: MAX_TOTAL_CHARS },
    },
    required: ["queries"],
  },
  annotations: { readOnlyHint: true },
} as const;
