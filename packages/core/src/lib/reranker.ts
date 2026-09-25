import { resolveEnv } from "../config/env.js";
import { buildTaxonomy, type Taxonomy } from "./taxonomy.js";
import type { SearchResult } from "./types.js";

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
export function getDefaultRerankerMode(): RerankerConfig["mode"] {
  const envMode = resolveEnv().rerankMode;
  if (envMode === "none" || envMode === "heuristic") return envMode;
  return "heuristic";
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
 * factors (relevance, draft status, recency). It nudges the retrieval order;
 * it does not replace it.
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
      (result.status === "draft" ? DRAFT_FACTOR : 1);

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
