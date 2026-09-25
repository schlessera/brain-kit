/**
 * Retrieval eval: score a query set with path judgments against the index of
 * the brain it runs in. `brain eval` is the CLI over this module; it owns the
 * validity gates that need the filesystem and the database, and this module
 * owns the set format and the arithmetic, so both can be tested without one.
 *
 * Format and metric definitions: docs/evaluating-search.md.
 */

import { z } from "zod";

import type { SearchResult } from "./types.js";

/** Bumped when a field of the `brain eval --json` envelope changes meaning. */
export const EVAL_SCHEMA_VERSION = 1;

/** The class that marks a query with no right answer in the brain. */
export const NO_ANSWER_CLASS = "no-answer";

/** Results fetched per query: the `brain search` default, or the largest k. */
export const MIN_POOL = 20;

/** MRR is cut at this rank. */
export const MRR_CUTOFF = 10;

export type EvalMode = "fts" | "vector" | "hybrid";

const querySchema = z
  .object({
    id: z.string().min(1),
    q: z.string().trim().min(1),
    class: z.string().min(1),
    expected: z.array(z.string().min(1)),
    lang: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.expected.length === 0 && query.class !== NO_ANSWER_CLASS) {
      ctx.addIssue({
        code: "custom",
        message: `an empty "expected" requires class "${NO_ANSWER_CLASS}"`,
      });
    }
    if (query.expected.length > 0 && query.class === NO_ANSWER_CLASS) {
      ctx.addIssue({
        code: "custom",
        message: `a "${NO_ANSWER_CLASS}" query must have an empty "expected"`,
      });
    }
  });

export type EvalQuery = z.infer<typeof querySchema>;

/**
 * Header keys this version understands. The header line is reserved for
 * date-relative sets (`now`), which this version does not evaluate yet, so a
 * header naming any key is refused rather than silently ignored.
 */
const KNOWN_HEADER_KEYS: readonly string[] = [];

/** A malformed set: a usage error that names the line. */
export class EvalSetError extends Error {}

export interface ParsedSet {
  header: Record<string, unknown> | null;
  queries: EvalQuery[];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Parse a JSONL query set. Blank lines are skipped. The first non-blank line
 * is a header when it is an object with neither `id` nor `q`.
 */
export function parseEvalSet(text: string): ParsedSet {
  let header: Record<string, unknown> | null = null;
  const queries: EvalQuery[] = [];
  const seen = new Map<string, number>();
  let first = true;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      throw new EvalSetError(`line ${lineNo}: not valid JSON (${(e as Error).message})`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EvalSetError(`line ${lineNo}: expected a JSON object`);
    }

    const isFirst = first;
    first = false;
    if (isFirst && !("id" in value) && !("q" in value)) {
      const unknown = Object.keys(value).filter((k) => !KNOWN_HEADER_KEYS.includes(k));
      if (unknown.length > 0) {
        throw new EvalSetError(
          `line ${lineNo}: header key ${unknown.map((k) => `"${k}"`).join(", ")} is not supported by this version of brain eval`
        );
      }
      header = value as Record<string, unknown>;
      continue;
    }

    const parsed = querySchema.safeParse(value);
    if (!parsed.success) {
      throw new EvalSetError(`line ${lineNo}: ${describeIssues(parsed.error)}`);
    }
    const earlier = seen.get(parsed.data.id);
    if (earlier !== undefined) {
      throw new EvalSetError(`line ${lineNo}: duplicate id "${parsed.data.id}" (first on line ${earlier})`);
    }
    seen.set(parsed.data.id, lineNo);
    queries.push(parsed.data);
  }

  return { header, queries };
}

/** The largest cutoff `--k` accepts; the pool, and so each search, grows with it. */
export const MAX_K = 1000;

/** Parse `--k 1,3,10` into sorted, distinct positive integers up to MAX_K. */
export function parseKs(raw: string): number[] {
  const ks = raw.split(",").map((part) => part.trim());
  const values = new Set<number>();
  for (const k of ks) {
    if (!/^[1-9]\d*$/.test(k)) {
      throw new EvalSetError(`--k takes positive integers separated by commas, got "${raw}"`);
    }
    const value = Number(k);
    if (!Number.isSafeInteger(value) || value > MAX_K) {
      throw new EvalSetError(`--k cutoffs go up to ${MAX_K}, got ${k.length > 12 ? `${k.slice(0, 12)}…` : k}`);
    }
    values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** How many results to fetch per query for the given cutoffs. */
export function poolSize(ks: number[]): number {
  return Math.max(MIN_POOL, MRR_CUTOFF, ...ks);
}

export interface QueryOutcome {
  mode: EvalMode;
  id: string;
  class: string;
  q: string;
  expected: string[];
  /** 1-based rank of the first expected path in the pool; null when absent. */
  rank: number | null;
  /** Hit at each k; null for a no-answer query, which is never scored. */
  hit_at: Record<string, boolean> | null;
  /** Reciprocal rank cut at MRR_CUTOFF; null for a no-answer query. */
  rr: number | null;
  /** Score of the top result; null when the search returned nothing. */
  top1_score: number | null;
  /** The top max(k) result paths, in rank order. */
  top: string[];
}

/** Score one query's ranked results against its judgments. */
export function scoreQuery(
  mode: EvalMode,
  query: EvalQuery,
  results: SearchResult[],
  ks: number[]
): QueryOutcome {
  const expected = new Set(query.expected);
  const index = results.findIndex((r) => expected.has(r.path));
  const rank = index === -1 ? null : index + 1;
  const answerable = query.expected.length > 0;
  const hitAt: Record<string, boolean> = {};
  for (const k of ks) hitAt[String(k)] = rank !== null && rank <= k;

  return {
    mode,
    id: query.id,
    class: query.class,
    q: query.q,
    expected: query.expected,
    rank: answerable ? rank : null,
    hit_at: answerable ? hitAt : null,
    rr: answerable ? (rank !== null && rank <= MRR_CUTOFF ? 1 / rank : 0) : null,
    top1_score: results.length > 0 ? results[0].score : null,
    top: results.slice(0, Math.max(...ks)).map((r) => r.path),
  };
}

export interface ScoreRow {
  mode: EvalMode;
  /** The query class, or null for the overall row over every answerable query. */
  class: string | null;
  n: number;
  /** Share of queries with an expected path in the top k; null for no-answer. */
  hit_at: Record<string, number> | null;
  mrr_at_10: number | null;
  /** Share of queries with an expected path anywhere in the fetched pool. */
  oracle: number | null;
  /** Median top-1 score of these queries; null when none returned a result. */
  top1_score_median: number | null;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function row(mode: EvalMode, cls: string | null, outcomes: QueryOutcome[], ks: number[]): ScoreRow {
  const top1 = median(outcomes.flatMap((o) => (o.top1_score === null ? [] : [o.top1_score])));
  if (cls === NO_ANSWER_CLASS) {
    return { mode, class: cls, n: outcomes.length, hit_at: null, mrr_at_10: null, oracle: null, top1_score_median: top1 };
  }
  const hitAt: Record<string, number> = {};
  for (const k of ks) hitAt[String(k)] = mean(outcomes.map((o) => (o.hit_at![String(k)] ? 1 : 0)));
  return {
    mode,
    class: cls,
    n: outcomes.length,
    hit_at: hitAt,
    mrr_at_10: mean(outcomes.map((o) => o.rr!)),
    oracle: mean(outcomes.map((o) => (o.rank !== null ? 1 : 0))),
    top1_score_median: top1,
  };
}

/**
 * Aggregate one mode's outcomes: an overall row over the answerable queries
 * (when there are any), then one row per class in first-seen order.
 */
export function aggregate(mode: EvalMode, outcomes: QueryOutcome[], ks: number[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  const answerable = outcomes.filter((o) => o.class !== NO_ANSWER_CLASS);
  if (answerable.length > 0) rows.push(row(mode, null, answerable, ks));

  const byClass = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) {
    const list = byClass.get(o.class) ?? [];
    list.push(o);
    byClass.set(o.class, list);
  }
  for (const [cls, list] of byClass) rows.push(row(mode, cls, list, ks));
  return rows;
}

/** A query this long or longer is contamination on its own when a document quotes it. */
export const CONTAMINATION_MIN_WORDS = 4;

/** This many of the set's queries in one document is contamination at any length. */
export const CONTAMINATION_MIN_QUERIES = 3;

/** Lowercase with every whitespace run collapsed to one space. */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Documents that quote the set's queries, which makes them answer their own
 * questions: a query set measures search only if search cannot see it. The
 * match is exact after lowercasing and collapsing whitespace. A document is
 * reported when it contains one query of CONTAMINATION_MIN_WORDS words or
 * more, or CONTAMINATION_MIN_QUERIES queries of any length. Returns one
 * warning per document, in the order given.
 */
export function findContamination(queries: EvalQuery[], documents: { path: string; text: string }[]): string[] {
  const needles = queries.map((q) => {
    const text = normalizeText(q.q);
    return { id: q.id, text, long: text.split(" ").length >= CONTAMINATION_MIN_WORDS };
  });
  const warnings: string[] = [];
  for (const doc of documents) {
    const haystack = normalizeText(doc.text);
    const found = needles.filter((n) => haystack.includes(n.text));
    if (found.length >= CONTAMINATION_MIN_QUERIES || found.some((n) => n.long)) {
      const ids = found.map((n) => n.id).join(", ");
      warnings.push(`contamination: ${doc.path} contains the text of ${found.length} of the set's queries (${ids})`);
    }
  }
  return warnings;
}
