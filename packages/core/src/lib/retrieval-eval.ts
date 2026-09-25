/**
 * Retrieval eval: score a query set with path judgments against the index of
 * the brain it runs in. `brain eval` is the CLI over this module; it owns the
 * validity gates that need the filesystem and the database, and this module
 * owns the set format and the arithmetic, so both can be tested without one.
 *
 * Format and metric definitions: docs/evaluating-search.md.
 */

import { z } from "zod";

import type { AssembleReport } from "./context-assembler.js";
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

/** A calendar date or a full ISO timestamp that `Date` can read. */
const isoDateSchema: z.ZodType<string> = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/, "an ISO date (YYYY-MM-DD) or timestamp")
  .refine((v) => isCalendarDate(v) && !Number.isNaN(Date.parse(v)), "not a real date");

/**
 * Whether the leading YYYY-MM-DD names a day that exists. `Date` rolls an
 * impossible day over without complaint (2026-02-30 becomes March 2), which
 * would silently move a run's now or a selector's bound, so the components
 * must survive a round trip.
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year); // Date.UTC maps years 0-99 to 1900-1999
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A time-relative answer: the documents whose frontmatter date `field` lies
 * after (or before) a bound, in `order`, first `take`. `"now"` is the run's
 * pinned now.
 */
const selectSchema = z
  .object({
    type: z.string().min(1).optional(),
    field: z.string().min(1),
    after: z.union([z.literal("now"), isoDateSchema]).optional(),
    before: z.union([z.literal("now"), isoDateSchema]).optional(),
    order: z.enum(["asc", "desc"]),
    take: z.number().int().positive(),
  })
  .strict()
  .refine((s) => s.after === undefined || s.before === undefined, "give after or before, not both");

export type Selector = z.infer<typeof selectSchema>;

/** Whether `value` is a date the set format accepts (as for the header's `now`). */
export function parseEvalDate(value: string): boolean {
  return isoDateSchema.safeParse(value).success;
}

const querySchema = z
  .object({
    id: z.string().min(1),
    q: z.string().trim().min(1),
    class: z.string().min(1),
    expected: z.array(z.string().min(1)).optional(),
    expect: z.object({ select: selectSchema }).strict().optional(),
    stale: z.array(z.string().min(1)).min(1).optional(),
    lang: z.string().min(1).optional(),
    /** Text the context eval looks for in the assembled output instead of an expected path. */
    answer: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if ((query.expected === undefined) === (query.expect === undefined)) {
      issue('give exactly one of "expected" and "expect"');
      return;
    }
    if (query.class === NO_ANSWER_CLASS) {
      if (query.expect) issue(`a "${NO_ANSWER_CLASS}" query cannot select its answers`);
      else if (query.expected!.length > 0) issue(`a "${NO_ANSWER_CLASS}" query must have an empty "expected"`);
      if (query.stale) issue(`a "${NO_ANSWER_CLASS}" query has no current answer for "stale" to rank below`);
      if (query.answer !== undefined) issue(`a "${NO_ANSWER_CLASS}" query has no "answer" to look for`);
    } else if (query.expected?.length === 0) {
      issue(`an empty "expected" requires class "${NO_ANSWER_CLASS}"`);
    }
  });

/** A query as written in the set: `expected` or a selector that resolves to it. */
export type EvalQuery = z.infer<typeof querySchema>;

/** A query whose selector, if any, has been resolved for this run. */
export type ResolvedQuery = EvalQuery & { expected: string[] };

const headerSchema = z.object({ now: isoDateSchema.optional() }).strict();

export type SetHeader = z.infer<typeof headerSchema>;

/** A malformed set: a usage error that names the line. */
export class EvalSetError extends Error {}

export interface ParsedSet {
  header: SetHeader | null;
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
  let header: SetHeader | null = null;
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
      const parsedHeader = headerSchema.safeParse(value);
      if (!parsedHeader.success) {
        throw new EvalSetError(`line ${lineNo}: header: ${describeIssues(parsedHeader.error)}`);
      }
      header = parsedHeader.data;
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
  /**
   * For a query with `stale` paths: whether the first expected path ranks
   * above every stale one, or no stale path is in the top max(k). Null when
   * the query names no stale paths.
   */
  current_first: boolean | null;
}

/** Score one query's ranked results against its judgments. */
export function scoreQuery(
  mode: EvalMode,
  query: ResolvedQuery,
  results: SearchResult[],
  ks: number[]
): QueryOutcome {
  const expected = new Set(query.expected);
  const index = results.findIndex((r) => expected.has(r.path));
  const rank = index === -1 ? null : index + 1;
  const answerable = query.expected.length > 0;
  const hitAt: Record<string, boolean> = {};
  for (const k of ks) hitAt[String(k)] = rank !== null && rank <= k;

  let currentFirst: boolean | null = null;
  if (query.stale) {
    const stale = new Set(query.stale);
    const staleIndex = results.findIndex((r) => stale.has(r.path));
    const staleRank = staleIndex === -1 ? null : staleIndex + 1;
    currentFirst = staleRank === null || staleRank > Math.max(...ks) || (rank !== null && rank < staleRank);
  }

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
    current_first: currentFirst,
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
  /** Share of this row's queries with `stale` paths that rank the current one first; null when none has any. */
  current_first: number | null;
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
    return {
      mode, class: cls, n: outcomes.length, hit_at: null, mrr_at_10: null, oracle: null,
      top1_score_median: top1, current_first: null,
    };
  }
  const judged = outcomes.flatMap((o) => (o.current_first === null ? [] : [o.current_first ? 1 : 0]));
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
    current_first: judged.length > 0 ? mean(judged) : null,
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds documents that quote the set's queries, which makes them answer their
 * own questions: a query set measures search only if search cannot see it.
 * A query matches as whole words after lowercasing and collapsing whitespace,
 * so "cat" does not match "concatenate". A document is reported when it
 * contains one query of CONTAMINATION_MIN_WORDS words or more, or
 * CONTAMINATION_MIN_QUERIES queries of any length. A query that lists the
 * document among its expected answers is left out of both counts for it.
 *
 * The queries are compiled once. `scan` takes one document at a time and
 * keeps only its finding, so a caller can feed documents as it reads them
 * without holding the corpus.
 */
export class ContaminationScanner {
  private readonly needles: { id: string; pattern: RegExp; long: boolean; answers: ReadonlySet<string> }[];
  private readonly found: string[] = [];

  /** Queries with their resolved `expected` paths (selectors already applied). */
  constructor(queries: { id: string; q: string; expected: string[] }[]) {
    this.needles = queries.map((q) => {
      const text = normalizeText(q.q);
      return {
        id: q.id,
        // A document quoting a query it is the answer to is not contamination:
        // an exact-title or alias query quotes its target by construction.
        answers: new Set(q.expected),
        // Word boundaries that hold for any script: no letter, digit or
        // underscore may touch the match on either side.
        pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(text)}(?![\\p{L}\\p{N}_])`, "u"),
        long: text.split(" ").length >= CONTAMINATION_MIN_WORDS,
      };
    });
  }

  scan(path: string, text: string): void {
    const haystack = normalizeText(text);
    const hits = this.needles.filter((n) => !n.answers.has(path) && n.pattern.test(haystack));
    if (hits.length >= CONTAMINATION_MIN_QUERIES || hits.some((n) => n.long)) {
      const ids = hits.map((n) => n.id).join(", ");
      this.found.push(`contamination: ${path} contains the text of ${hits.length} of the set's queries (${ids})`);
    }
  }

  /** One warning per contaminated document, in the order scanned. */
  warnings(): string[] {
    return [...this.found];
  }
}

/** A markdown document's frontmatter, for resolving selectors. */
export interface FrontmatterDocument {
  path: string;
  data: Record<string, unknown>;
  /** The raw frontmatter text, to check a date YAML already turned into a `Date`. */
  raw?: string;
}

/** A frontmatter date as epoch ms: a YAML date (gray-matter gives a Date) or an ISO string. */
function dateValue(doc: FrontmatterDocument, field: string): number | null {
  const value = doc.data[field];
  if (value instanceof Date) {
    // YAML already rolled an impossible day over (`deadline: 2026-02-30` is
    // March 2 by now), so check the scalar as written when it can be found.
    const written = doc.raw
      ?.match(new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*["']?(\\d{4}-\\d{2}-\\d{2})`, "m"))?.[1];
    if (written !== undefined && !isCalendarDate(written)) return null;
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== "string" || !isCalendarDate(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The paths a selector picks at `now`: documents (of `type`, when given)
 * whose `field` is a date strictly after / before the bound, ordered by that
 * date (ties by path), first `take`. A document without a readable, real
 * date in `field` is never selected, and neither is one the indexer skips
 * (no `title` or `type`, `parseMarkdownFiles` in lib/indexer/parse.ts): it
 * could never be a search result, so it must not take a `take` slot.
 */
export function selectPaths(select: Selector, documents: FrontmatterDocument[], now: Date): string[] {
  const bound = (b: string) => (b === "now" ? now.getTime() : Date.parse(b));
  const after = select.after === undefined ? null : bound(select.after);
  const before = select.before === undefined ? null : bound(select.before);
  const candidates = documents.flatMap((doc) => {
    if (!doc.data.title || !doc.data.type) return [];
    if (select.type !== undefined && doc.data.type !== select.type) return [];
    const at = dateValue(doc, select.field);
    if (at === null) return [];
    if (after !== null && !(at > after)) return [];
    if (before !== null && !(at < before)) return [];
    return [{ path: doc.path, at }];
  });
  const sign = select.order === "asc" ? 1 : -1;
  candidates.sort((a, b) => sign * (a.at - b.at) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return candidates.slice(0, select.take).map((c) => c.path);
}

/** The largest `--budgets` value accepted, in tokens. */
export const MAX_BUDGET = 1_000_000;

/** Parse `--budgets 1000,4000,8000` into sorted, distinct positive integers up to MAX_BUDGET. */
export function parseBudgets(raw: string): number[] {
  const values = new Set<number>();
  for (const part of raw.split(",").map((p) => p.trim())) {
    if (!/^[1-9]\d*$/.test(part)) {
      throw new EvalSetError(`--budgets takes positive integers separated by commas, got "${raw}"`);
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value > MAX_BUDGET) {
      throw new EvalSetError(`--budgets values go up to ${MAX_BUDGET}, got ${part.length > 12 ? `${part.slice(0, 12)}…` : part}`);
    }
    values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** What `brain context` put in its output, as the assembler reported it. */
export interface ContextSections {
  /** 1 when the identity section (whole or cut) is in. */
  identity: number;
  /** 1 when the current-focus section is in. */
  focus: number;
  /** Search-result sections. */
  results: number;
  /** Documents in the `### Related` list. */
  related: number;
}

/** Count the assembled context's sections from the assembler's report. */
export function contextSections(report: AssembleReport): ContextSections {
  return {
    identity: report.identity === null ? 0 : 1,
    focus: report.focus === null ? 0 : 1,
    results: report.results.length,
    related: report.related.length,
  };
}

/**
 * Whether the assembled context carries a query's answer. With `answer`, the
 * text itself must appear in the output (case and whitespace ignored).
 * Otherwise an expected path must be one the assembler reports as a search
 * hit, or as the source of the identity or current-focus section. A document
 * in the Related list is not an answer: only its summary line is there. The
 * report comes from the assembler, so nothing in a document's own text (a
 * quoted heading, a fenced example) can pass for a section.
 */
export function answerPresent(
  output: string,
  report: AssembleReport,
  query: { expected: string[]; answer?: string }
): boolean {
  if (query.answer !== undefined) {
    const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ");
    return squash(output).includes(squash(query.answer).trim());
  }
  return query.expected.some(
    (path) => report.results.includes(path) || path === report.identity || path === report.focus
  );
}

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}
