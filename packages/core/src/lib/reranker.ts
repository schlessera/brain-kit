import { resolveEnv } from "../config/env.js";
import type { Ranked, RerankCandidate, Reranker, SearchMode } from "./seams.js";
import { buildTaxonomy, type Taxonomy } from "./taxonomy.js";
import type { SearchResult } from "./types.js";

/**
 * How a search reranks: `none` keeps the retrieval order untouched,
 * `heuristic` multiplies it by the lifecycle factors below, and `jev` orders
 * the candidates by a relevance judgment (a `Reranker`, TypeSafe's Jev by
 * default) that sees each candidate's lifecycle fields as evidence. `jev`
 * does not apply the multipliers on top: measured on a 1,133-document brain,
 * they undid the judgment (hand-set vector hit@1 0.852 → 0.444) because on a
 * rank-derived scale a ×0.85 factor moves a result about ten places.
 */
export const RERANK_MODES = ["none", "heuristic", "jev"] as const;
export type RerankMode = (typeof RERANK_MODES)[number];

export function isRerankMode(value: unknown): value is RerankMode {
  return typeof value === "string" && (RERANK_MODES as readonly string[]).includes(value);
}

/** The lifecycle-factor pass (`heuristic`); `mode` is `none` or `heuristic`. */
export interface RerankerConfig {
  mode: "none" | "heuristic";
  /** The moment recency is measured from. Defaults to the wall clock. */
  now?: Date;
  /** The brain's types, which carry the recency half-lives. Defaults to the
   * core types alone. */
  taxonomy?: Taxonomy;
}

// Lifecycle factors only (#422): what the brain's own metadata says about a
// document, not how its text matches the query (fusion and alias matching
// cover that). They multiply, so they keep their relative effect on any score
// scale; vector mode hands them a rank-derived score (see search-engine.ts).
const RELEVANCE_FACTOR: Record<string, number> = {
  primary: 1.15,
  secondary: 1.0,
  historical: 0.85,
};

const DRAFT_FACTOR = 0.9; // drafts are unfinished — slight deboost vs active docs
// Produced by a tool or an agent from another source (`generated_from`, #430):
// the source is usually the better hit, so the derivative weighs like a
// historical document.
const GENERATED_FACTOR = 0.85;

// A doc loses half its recency credit per half-life; the decay multiplies the
// score between RECENCY_FLOOR (infinitely old) and 1.0 (updated today). The
// half-lives come from the type specs (`halfLifeDays`, else `staleDays`), so
// they follow whatever taxonomy the brain configures.
const DEFAULT_HALF_LIFE_DAYS = 365;
const RECENCY_FLOOR = 0.7;
const MS_PER_DAY = 86_400_000;

/**
 * Get the default reranker mode based on environment.
 */
export function getDefaultRerankerMode(): RerankMode {
  return envRerankMode() ?? "heuristic";
}

/** BRAIN_RERANK_MODE when it names a mode, else undefined. */
export function envRerankMode(): RerankMode | undefined {
  const envMode = resolveEnv().rerankMode;
  return isRerankMode(envMode) ? envMode : undefined;
}

let coreTaxonomy: Taxonomy | undefined;

/**
 * Recency half-life in days for every type in a taxonomy: the type's
 * `halfLifeDays`, else its `staleDays`, else 365. Without a taxonomy, the core
 * types alone.
 */
export function halfLifeTable(taxonomy?: Taxonomy): Record<string, number> {
  taxonomy ??= coreTaxonomy ??= buildTaxonomy({});
  return Object.fromEntries(
    Object.entries(taxonomy.types).map(([type, spec]) => [
      type,
      spec.halfLifeDays ?? spec.staleDays ?? DEFAULT_HALF_LIFE_DAYS,
    ])
  );
}

/**
 * Recency factor — exponential decay on the document's `updated` date with a
 * type-specific half-life, floored so old-but-relevant docs still surface.
 */
export function recencyFactor(
  type: string,
  updated: string | undefined,
  now: number = Date.now(),
  halfLives: Record<string, number> = halfLifeTable()
): number {
  if (!updated) return 1;
  const updatedMs = new Date(updated).getTime();
  if (Number.isNaN(updatedMs)) return 1;

  const ageDays = Math.max(0, (now - updatedMs) / MS_PER_DAY);
  const halfLife = halfLives[type] ?? DEFAULT_HALF_LIFE_DAYS;
  const decay = Math.pow(0.5, ageDays / halfLife);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay;
}

/**
 * Heuristic reranker: multiplies each score by the document's lifecycle
 * factors (relevance, draft status, `generated_from`, recency). It nudges the
 * retrieval order; it does not replace it.
 */
function heuristicRerank(
  candidates: SearchResult[],
  now: number,
  halfLives: Record<string, number>
): SearchResult[] {
  const scored = candidates.map((result) => {
    const factor =
      (RELEVANCE_FACTOR[result.relevance] ?? 1) *
      recencyFactor(result.type, result.updated, now, halfLives) *
      (result.status === "draft" ? DRAFT_FACTOR : 1) *
      (result.generatedFrom ? GENERATED_FACTOR : 1);

    return {
      ...result,
      score: result.score * factor,
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Rerank search results using the specified strategy. `query` is kept for
 * the signature's stability; the lifecycle factors do not read it.
 */
export function rerank(
  _query: string,
  candidates: SearchResult[],
  config: RerankerConfig
): SearchResult[] {
  const now = config.now?.getTime() ?? Date.now();
  if (Number.isNaN(now)) throw new Error("rerank: now must be a valid Date");
  if (config.mode === "none" || candidates.length === 0) {
    return candidates;
  }

  return heuristicRerank(candidates, now, halfLifeTable(config.taxonomy));
}

// ---------------------------------------------------------------------------
// Running a Reranker safely: exclusion, placement, validation. hybridSearch
// uses these, and they are exported so a search that fans out over several
// sources can rerank the union the same way.
// ---------------------------------------------------------------------------

/**
 * Build a path matcher from the `reranker.exclude` config. A pattern with no
 * glob characters is a directory or file prefix (`career` matches
 * `career/x.md`); anything else is a Bun.Glob matched against the whole path.
 */
export function buildPathMatcher(patterns: readonly string[] | undefined): ((path: string) => boolean) | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  const prefixes: string[] = [];
  const globs: Bun.Glob[] = [];
  for (const raw of patterns) {
    const p = raw.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!p) continue;
    if (/[*?[\]{}]/.test(p)) globs.push(new Bun.Glob(p));
    else prefixes.push(p);
  }
  return (path) =>
    prefixes.some((p) => path === p || path.startsWith(p + "/")) ||
    globs.some((g) => g.match(path));
}

export interface RerankPartition<T> {
  /** Candidates the reranker may see, in retrieval order. */
  sendable: T[];
  /** Retrieval index → withheld candidate. */
  withheld: Map<number, T>;
}

/** Split candidates into what a network reranker may see and what stays home. */
export function partitionForRerank<T>(
  candidates: readonly T[],
  isExcluded: ((candidate: T) => boolean) | undefined
): RerankPartition<T> {
  const sendable: T[] = [];
  const withheld = new Map<number, T>();
  candidates.forEach((c, i) => {
    if (isExcluded?.(c)) withheld.set(i, c);
    else sendable.push(c);
  });
  return { sendable, withheld };
}

/**
 * Placement policy for withheld candidates: each keeps its retrieval rank, and
 * the reranked remainder fills the other positions in the reranker's order.
 */
export function mergeWithheld<T>(ranked: readonly T[], withheld: Map<number, T>, total: number): T[] {
  const out: T[] = new Array(total);
  for (const [i, c] of withheld) out[i] = c;
  let next = 0;
  for (let i = 0; i < total; i++) {
    if (out[i] !== undefined) continue;
    out[i] = ranked[next++];
  }
  return out;
}

/** The identity a reranker must preserve: `source` + `id`. */
export function candidateKey(c: RerankCandidate): string {
  return c.source ? `${c.source}:${c.id}` : c.id;
}

/**
 * A reranker must return a permutation of what it was given. Anything else —
 * dropped, duplicated or invented candidates, a non-finite score — is treated
 * as a failed call so the caller falls back to retrieval order instead of
 * returning a partial list.
 */
export function assertPermutation<C extends RerankCandidate>(
  input: readonly C[],
  output: readonly Ranked<C>[]
): void {
  if (output.length !== input.length) {
    throw new Error(`reranker returned ${output.length} of ${input.length} candidates`);
  }
  const given = new Set<RerankCandidate>(input);
  const seen = new Set<RerankCandidate>();
  for (const { item, score } of output) {
    const key = item && typeof item === "object" ? candidateKey(item) : String(item);
    // By reference: a copy would lose whatever the caller attached to it.
    if (!given.has(item)) {
      throw new Error(`reranker returned a candidate that is not one it was given (a copy?): ${key}`);
    }
    if (seen.has(item)) {
      throw new Error(`reranker returned a duplicate candidate: ${key}`);
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`reranker returned a non-finite score for ${key}`);
    }
    seen.add(item);
  }
}

/** True when the reranker serves the lane the search ran in (a union has no lane). */
export function supportsMode(reranker: Reranker, mode: SearchMode | undefined): boolean {
  return mode === undefined || reranker.capabilities.modes.includes(mode);
}
