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

// Multiplicative boosts: they preserve their relative effect regardless of the
// base score scale (RRF fusion scores sit around 0.01–0.03, single-source BM25
// scores around 1–10 — additive nudges were no-ops on the latter).
const RELEVANCE_FACTOR: Record<string, number> = {
  primary: 1.15,
  secondary: 1.0,
  historical: 0.85,
};

const TITLE_MATCH_FACTOR = 0.25; // up to ×1.25 when every query term hits the title
const ASSET_FACTOR = 1.3;
const DRAFT_FACTOR = 0.9; // drafts are unfinished — slight deboost vs active docs

// A doc loses half its recency credit per half-life; the decay multiplies the
// score between RECENCY_FLOOR (infinitely old) and 1.0 (updated today). The
// half-lives come from the type specs (`halfLifeDays`, else `staleDays`), so
// they follow whatever taxonomy the brain configures.
const DEFAULT_HALF_LIFE_DAYS = 365;
const RECENCY_FLOOR = 0.7;
const MS_PER_DAY = 86_400_000;

const VISUAL_INTENT_KEYWORDS = [
  "photo", "image", "picture", "slide", "diagram", "screenshot",
  "deck", "headshot", "portrait", "cv", "resume", "pdf", "presentation",
];

function hasVisualIntent(queryTerms: string[]): boolean {
  return queryTerms.some((t) =>
    VISUAL_INTENT_KEYWORDS.some((k) => t.includes(k))
  );
}

function isAssetResult(path: string): boolean {
  return /\.(jpg|jpeg|png|pdf)$/i.test(path);
}

/**
 * Get the default reranker mode based on environment.
 */
export function getDefaultRerankerMode(): RerankerConfig["mode"] {
  const envMode = resolveEnv().rerankMode;
  if (envMode === "none" || envMode === "heuristic") return envMode;
  return "heuristic";
}

/**
 * Title match factor — scales with the fraction of query terms found in the title.
 */
function titleMatchFactor(title: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 1;
  const titleLower = title.toLowerCase();
  const matchCount = queryTerms.filter((term) => titleLower.includes(term)).length;
  return 1 + TITLE_MATCH_FACTOR * (matchCount / queryTerms.length);
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
 * Heuristic reranker: applies domain-specific multiplicative factors to
 * retrieval scores. Nudges ordering without overriding the retrieval signal.
 */
function heuristicRerank(
  query: string,
  candidates: SearchResult[],
  now: number,
  halfLives: Record<string, number>
): SearchResult[] {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const visualIntent = hasVisualIntent(queryTerms);

  const scored = candidates.map((result) => {
    const factor =
      (RELEVANCE_FACTOR[result.relevance] ?? 1) *
      titleMatchFactor(result.title, queryTerms) *
      recencyFactor(result.type, result.updated, now, halfLives) *
      (result.status === "draft" ? DRAFT_FACTOR : 1) *
      (visualIntent && isAssetResult(result.path) ? ASSET_FACTOR : 1);

    return {
      ...result,
      score: result.score * factor,
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Rerank search results using the specified strategy.
 */
export function rerank(
  query: string,
  candidates: SearchResult[],
  config: RerankerConfig
): SearchResult[] {
  const now = config.now?.getTime() ?? Date.now();
  if (Number.isNaN(now)) throw new Error("rerank: now must be a valid Date");
  if (config.mode === "none" || candidates.length <= 1) {
    return candidates;
  }

  return heuristicRerank(query, candidates, now, halfLifeTable(config.taxonomy));
}
