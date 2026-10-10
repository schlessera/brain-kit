import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

import type { BrainContext } from "../../lib/context.js";
import { loadVecSupport } from "../../lib/db.js";
import { getMarkdownFiles } from "../../lib/indexer.js";
import { rerankSetup, type RerankSetup } from "../../lib/registry.js";
import { envRerankMode } from "../../lib/reranker.js";
import {
  aggregate,
  EVAL_SCHEMA_VERSION,
  NO_ANSWER_CLASS,
  EvalSetError,
  ContaminationScanner,
  parseEvalSet,
  titleLeaks,
  parseKs,
  parseBudgets,
  answerPresent,
  contextSections,
  percentile,
  poolSize,
  scoreQuery,
  parseEvalDate,
  selectPaths,
} from "../../lib/retrieval-eval.js";
import type {
  EvalMode,
  EvalQuery,
  FrontmatterDocument,
  QueryOutcome,
  ResolvedQuery,
  ScoreRow,
  SetHeader,
} from "../../lib/retrieval-eval.js";
import { resolveWritable, safeResolve, writeFileSafely } from "../../lib/safe-path.js";
import { isInScratch, isWriteRefusal, writeScratchFile } from "../../lib/scratch.js";
import { hybridSearch, type SearchDeps } from "../../lib/search-engine.js";
import type { EmbeddingProvider } from "../../lib/seams.js";
import { packageRoot, packageVersion } from "../../package-version.js";
import { assembleContext, emptyAssembleReport, estimateTokens } from "../../lib/context-assembler.js";
import type { ContextSections } from "../../lib/retrieval-eval.js";
import { BaselineError, compareRuns, parseStoredRun, redactEnvelope } from "../../lib/eval-baseline.js";
import type { BaselineReport, StoredRun } from "../../lib/eval-baseline.js";
import type { CliContext, CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs, UsageError } from "../io.js";

const DOCS_POINTER =
  "See docs/evaluating-search.md (https://github.com/schlessera/brain-kit/blob/main/docs/evaluating-search.md) for the format.";

const HELP = `brain eval — score a retrieval query set against this brain's index

  --set <file>            JSONL query set (default: evals/retrieval.jsonl)
  --mode <mode>           fts|vector|hybrid|all (default: hybrid)
  --rerank <mode>         none|heuristic|jev (default: the search default);
                          meta.reranker names the judgment reranker, if any
  --k <list>              hit@k cutoffs, comma-separated (default: 1,3,10)
  --out <file>            Also write the JSON result to <file>, inside the brain
  --strict                Refuse (exit 2) when an indexed document quotes the set's queries
  --now <ISO date>        The moment the run measures from, when the set's header
                          does not pin one (default: the wall clock)
  --context               Also run each query through \`brain context\` at each budget
                          and report whether the answer is in it (the "context" block)
  --budgets <list>        Context budgets in tokens, comma-separated
                          (default: 1000,4000,8000; needs --context)
  --lint                  Validate the set and report title leakage in its
                          "paraphrase" queries, without scoring or opening the
                          index: exit 0 with findings, 2 on a malformed set

Relative paths are relative to the brain root.

Against a stored run (one written with --out):
  --baseline <file>       Compare per query on hit@k; gate on hit@1
  --max-net-loss <n>      Fail when lost − gained on hit@1 reaches n (default: 2)
  --must-pass <classes>   Fail when any query in these classes (comma-separated) is lost
  --allow-set-change      Compare the queries both runs share when the set changed
  --redact                Leave query text and every path out of the output, --out
                          and a refusal's details; an error about a path you passed
                          (--set, --baseline, --out) still repeats it

Exit codes: 0 scored (and the gate passed) · 1 the baseline gate failed · 3 not
comparable with the baseline (a different set, mode, embedding model or k) ·
2 refused or misused: a usage error or malformed set (unlike other brain
commands, so 1 always means a regression), or a validity gate failed (missing
or empty set, an expected or stale path not on disk or not indexed, a
selector that selects nothing, the index older than the markdown, a requested
search lane degraded; with --strict, an indexed document that contains the
set's queries).

--json envelope: { "schema_version", "meta", "rows", "per_query", "warnings" },
plus "context": { "budgets", "rows", "per_query" } with --context
(--lint: { "schema_version", "meta": { "set", "set_sha256", "queries" }, "warnings" })
Set format and how to read the numbers: docs/evaluating-search.md`;

const MODES: Readonly<Record<string, EvalMode[]>> = {
  fts: ["fts"],
  vector: ["vector"],
  hybrid: ["hybrid"],
  all: ["fts", "vector", "hybrid"],
};

/** A validity gate failed: exit 2, and no score is printed or written. */
class EvalRefused extends Error {
  constructor(readonly reason: string, readonly details: string[] = []) {
    super(reason);
  }
}

/** Show a path relative to the brain root when it lies inside it. */
function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** The core package's own directory when it runs from a checkout, else null. */
function checkoutSource(): string | null {
  try {
    const dir = realpathSync(packageRoot());
    return dir.split(sep).includes("node_modules") ? null : dir;
  } catch {
    return null;
  }
}

function loadSet(
  path: string,
  root: string,
  redact: boolean
): { header: SetHeader | null; queries: EvalQuery[]; sha256: string } {
  const shown = displayPath(root, path);
  if (!existsSync(path)) {
    throw new EvalRefused(`no query set at ${shown}. ${DOCS_POINTER}`);
  }
  const bytes = readFileSync(path);
  let parsed;
  try {
    parsed = parseEvalSet(bytes.toString("utf-8"));
  } catch (e) {
    if (e instanceof EvalSetError) {
      // The reason can quote the line, and so the query text.
      throw new UsageError(redact ? `${shown}: line ${e.line}: malformed (withheld by --redact)` : `${shown}: ${e.message}`);
    }
    throw e;
  }
  if (parsed.queries.length === 0) {
    throw new EvalRefused(`the query set at ${shown} has no queries. ${DOCS_POINTER}`);
  }
  return { header: parsed.header, queries: parsed.queries, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * The run's now: the set's header pins it, then `--now`, then the wall
 * clock. A header wins over the flag because a set whose answers depend on
 * the date is only reproducible at the date it was written for; the flag is
 * reported as ignored rather than silently dropped.
 */
function resolveNow(header: SetHeader | null, flag: string | undefined): { now: Date; warnings: string[] } {
  if (header?.now !== undefined) {
    const warnings =
      flag !== undefined && Date.parse(flag) !== Date.parse(header.now)
        ? [`--now ${flag} ignored: the set's header pins now to ${header.now}`]
        : [];
    return { now: new Date(header.now), warnings };
  }
  return { now: flag !== undefined ? new Date(flag) : new Date(), warnings: [] };
}

/**
 * Turn each selector into this run's `expected`, reading frontmatter from the
 * markdown the taxonomy indexes (not brain.db, so a selector sees exactly
 * what is on disk). A selector that selects nothing refuses the run: the
 * query would have no right answer to score.
 */
function resolveQueries(brain: BrainContext, queries: EvalQuery[], now: Date): ResolvedQuery[] {
  let documents: FrontmatterDocument[] | undefined;
  const load = (): FrontmatterDocument[] =>
    (documents ??= getMarkdownFiles(brain.root, brain.taxonomy).flatMap((path) => {
      try {
        const parsed = parseFrontmatter(readFileSync(join(brain.root, path), "utf-8"));
        return [{ path, data: parsed.data, raw: parsed.matter }];
      } catch {
        return []; // unreadable or invalid frontmatter: the indexer skips it too
      }
    }));
  const empty: string[] = [];
  const resolved = queries.map((query): ResolvedQuery => {
    if (!query.expect) return { ...query, expected: query.expected! };
    const expected = selectPaths(query.expect.select, load(), now);
    if (expected.length === 0) empty.push(`${query.id}: ${JSON.stringify(query.expect.select)} at ${now.toISOString()}`);
    return { ...query, expected };
  });
  if (empty.length > 0) {
    throw new EvalRefused(`${empty.length} selector(s) select no document`, empty);
  }
  return resolved;
}

/**
 * Every expected path must be a file inside the brain that the index holds.
 * Containment is symlink-aware (`safeResolve`): a link inside the brain that
 * points out of it is outside.
 */
function checkExpectedPaths(root: string, db: Database, queries: ResolvedQuery[]): void {
  const indexed = db.prepare("SELECT 1 FROM documents WHERE path = ?");
  const outside: string[] = [];
  const missing: string[] = [];
  const notFiles: string[] = [];
  const unindexed: string[] = [];
  for (const query of queries) {
    for (const path of [...query.expected, ...(query.stale ?? [])]) {
      const full = safeResolve(root, path);
      if (!full) outside.push(`${query.id}: ${path}`);
      else if (!existsSync(full)) missing.push(`${query.id}: ${path}`);
      // `full` is canonical, so a symlink has already been followed here.
      else if (!statSync(full).isFile()) notFiles.push(`${query.id}: ${path}`);
      else if (!indexed.get(path)) unindexed.push(`${query.id}: ${path}`);
    }
  }
  if (outside.length > 0) {
    throw new EvalRefused(`${outside.length} expected path(s) resolve outside the brain root`, outside);
  }
  if (missing.length > 0) {
    throw new EvalRefused(`${missing.length} expected path(s) do not exist in the brain`, missing);
  }
  if (notFiles.length > 0) {
    throw new EvalRefused(`${notFiles.length} expected path(s) are not regular files`, notFiles);
  }
  if (unindexed.length > 0) {
    throw new EvalRefused(
      `${unindexed.length} expected path(s) are not in the index (excluded, or missing title/type)`,
      unindexed
    );
  }
}

/**
 * The index must describe the markdown on disk, or the run scores yesterday's
 * brain. Compares content hashes the way the indexer does
 * (`parseMarkdownFiles`, packages/core/src/lib/indexer/parse.ts), so a file
 * the indexer would skip (no title/type) is not reported as unindexed. An
 * indexed file that cannot be read cannot be shown to be fresh, so it refuses
 * the run too; an unreadable file the index does not hold is one the indexer
 * skips as well.
 */
function checkIndexFresh(brain: BrainContext, db: Database, scanner: ContaminationScanner): void {
  const rows = db
    .prepare("SELECT path, content_hash FROM documents WHERE asset_type = 'markdown'")
    .all() as { path: string; content_hash: string | null }[];
  const hashes = new Map(rows.map((r) => [r.path, r.content_hash]));
  const stale: string[] = [];

  const onDisk = getMarkdownFiles(brain.root, brain.taxonomy);
  const present = new Set(onDisk);
  for (const path of onDisk) {
    let raw: string;
    try {
      raw = readFileSync(join(brain.root, path), "utf-8");
    } catch (e) {
      if (!hashes.has(path)) continue;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") present.delete(path); // gone since the scan: reported below
      else stale.push(`${path}: cannot be read to check it against the index (${code ?? (e as Error).message})`);
      continue;
    }
    if (hashes.has(path)) {
      if (hashes.get(path) !== createHash("sha256").update(raw).digest("hex")) {
        stale.push(`${path}: changed since it was indexed`);
      }
      // The contamination scan reads these same bytes, so it sees exactly
      // what the index holds, and an unreadable file has already refused.
      scanner.scan(path, raw);
      continue;
    }
    try {
      const { data } = parseFrontmatter(raw);
      if (data.title && data.type) stale.push(`${path}: not indexed yet`);
    } catch {
      /* invalid frontmatter: the indexer skips it too */
    }
  }
  for (const path of hashes.keys()) {
    if (!present.has(path)) stale.push(`${path}: deleted since it was indexed`);
  }

  if (stale.length > 0) {
    throw new EvalRefused(
      `the index is older than the markdown (${stale.length} file(s)) — run \`brain index\` first`,
      stale
    );
  }
}


/** The rerank deadline a scoring run allows (it measures order, not latency). */
const EVAL_RERANK_TIMEOUT_MS = 20_000;

async function runMode(
  db: Database,
  mode: EvalMode,
  queries: ResolvedQuery[],
  opts: { rerank: "none" | "heuristic" | "jev"; ks: number[]; pool: number; now: Date },
  deps: SearchDeps
): Promise<QueryOutcome[]> {
  const outcomes: QueryOutcome[] = [];
  for (const query of queries) {
    const { results, warnings } = await hybridSearch(
      db,
      { query: query.q, mode, rerank: opts.rerank, limit: opts.pool, now: opts.now },
      // The brain's taxonomy, as `brain search` passes it: the reranker's
      // recency half-lives come from its types, so without it the run would
      // score a ranking no user sees.
      deps
    );
    // Any warning means the lane did not run as requested, and scoring the
    // fallback under the requested mode's name would misreport it.
    if (warnings.length > 0) {
      throw new EvalRefused(
        `the ${mode} lane degraded on query "${query.id}"`,
        warnings.map((w) => `${mode}: ${w}`)
      );
    }
    outcomes.push(scoreQuery(mode, query, results, opts.ks));
  }
  return outcomes;
}

interface ContextOutcome {
  budget: number;
  id: string;
  class: string;
  /** Null for a no-answer query, which has no answer to find. */
  answer_present: boolean | null;
  /** estimateTokens(output) / budget, the assembler's own estimate. */
  budget_used: number;
  sections: ContextSections;
}

interface ContextRow {
  budget: number;
  /** Answerable queries: the denominator of answer_present. */
  n: number;
  answer_present: number | null;
  budget_used: { median: number; p10: number; p90: number };
}

/**
 * Run every query through the assembler `brain context` uses, at each budget.
 * Its search degrades the way `brain context` does (no vector lane without a
 * provider), so its warnings are reported once each, never refused: this
 * measures what an agent is actually handed.
 */
async function runContext(
  db: Database,
  brain: BrainContext,
  queries: ResolvedQuery[],
  budgets: number[],
  now: Date,
  embeddings: EmbeddingProvider | undefined,
  warnings: string[],
  rerank: RerankSetup
): Promise<{ budgets: number[]; rows: ContextRow[]; per_query: ContextOutcome[] }> {
  const searchWarnings = new Set<string>();
  const perQuery: ContextOutcome[] = [];
  const rows: ContextRow[] = [];
  for (const budget of budgets) {
    const outcomes: ContextOutcome[] = [];
    for (const query of queries) {
      const found: string[] = [];
      const report = emptyAssembleReport();
      const output = await assembleContext(db, brain, { query: query.q, maxTokens: budget, embeddings, now, warnings: found, report, rerank });
      found.forEach((w) => searchWarnings.add(w));
      outcomes.push({
        budget,
        id: query.id,
        class: query.class,
        answer_present: query.class === NO_ANSWER_CLASS ? null : answerPresent(output, report, query),
        budget_used: estimateTokens(output) / budget,
        sections: contextSections(report),
      });
    }
    const answerable = outcomes.flatMap((o) => (o.answer_present === null ? [] : [o.answer_present ? 1 : 0]));
    const used = outcomes.map((o) => o.budget_used);
    rows.push({
      budget,
      n: answerable.length,
      answer_present: answerable.length > 0 ? answerable.reduce((a, b) => a + b, 0) / answerable.length : null,
      budget_used: { median: percentile(used, 50), p10: percentile(used, 10), p90: percentile(used, 90) },
    });
    perQuery.push(...outcomes);
  }
  for (const w of searchWarnings) warnings.push(`context: ${w}`);
  return { budgets, rows, per_query: perQuery };
}

function printContext(context: { rows: ContextRow[] }): void {
  console.log("\nContext (brain context at each budget):");
  const header = ["budget", "n", "answer present", "used p10", "used median", "used p90"];
  const table = context.rows.map((r) => [
    String(r.budget),
    String(r.n),
    pct(r.answer_present),
    pct(r.budget_used.p10),
    pct(r.budget_used.median),
    pct(r.budget_used.p90),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  for (const row of table) console.log(line(row));
}

function printBaseline(report: BaselineReport): void {
  console.log(`\nAgainst the baseline${report.file ? ` ${report.file}` : ""} (recorded with ${report.version}):`);
  if (!report.comparable) {
    for (const reason of report.not_comparable) console.log(`  not comparable: ${reason}`);
    return;
  }
  const list = (ids: string[]) => (ids.length ? ids.join(", ") : "-");
  const flips = (f: { lost: string[]; gained: string[]; unchanged: number }) =>
    `lost ${f.lost.length} (${list(f.lost)}), gained ${f.gained.length} (${list(f.gained)}), unchanged ${f.unchanged}`;
  for (const m of report.modes) {
    for (const [k, f] of Object.entries(m.hit_at)) {
      console.log(`  [${m.mode}] hit@${k}: ${flips(f)}, sign test p ${f.sign_test_p.toPrecision(3)}`);
      for (const c of m.per_class) console.log(`      ${c.class}: ${flips(c.hit_at[k])}`);
    }
  }
  console.log(report.gate.failed ? `  FAILED: ${report.gate.reasons.join("; ")}` : "  gate passed");
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

/** A per-query outcome as the output carries it: `--redact` drops `q`, `expected` and `top`. */
type ShownOutcome = Omit<QueryOutcome, "q" | "expected" | "top"> & { top?: string[] };

function printHuman(
  rows: ScoreRow[],
  perQuery: ShownOutcome[],
  ks: number[],
  meta: Record<string, unknown>,
  warnings: string[]
): void {
  console.log(`brain eval — ${meta.queries} queries, ${meta.documents} documents, now ${meta.now}\n`);
  for (const warning of warnings) console.log(`Warning: ${warning}`);
  if (warnings.length > 0) console.log();
  const header = ["mode", "class", "n", ...ks.map((k) => `hit@${k}`), "MRR@10", "oracle", "top1 median", "current first"];
  const table = rows.map((r) => [
    r.mode,
    r.class ?? "(all answerable)",
    String(r.n),
    ...ks.map((k) => pct(r.hit_at?.[String(k)] ?? null)),
    r.mrr_at_10 === null ? "-" : r.mrr_at_10.toFixed(3),
    pct(r.oracle),
    r.top1_score_median === null ? "-" : r.top1_score_median.toPrecision(3),
    pct(r.current_first),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  for (const row of table) console.log(line(row));

  const misses = perQuery.filter((o) => o.hit_at !== null && !o.hit_at[String(ks[0])]);
  if (misses.length > 0) {
    console.log(`\nMissed at hit@${ks[0]}:`);
    for (const o of misses) {
      const where = o.rank === null ? "not in the pool" : `rank ${o.rank}`;
      const top = o.top === undefined ? "(withheld)" : (o.top[0] ?? "(nothing)");
      console.log(`  [${o.mode}] ${o.id} (${o.class}): ${where}; top: ${top}`);
    }
  }
}

/**
 * Write `--out` the way `render --out` does: re-resolve the directory, never
 * write through a link, and hold a target in the scratch area to its rules.
 * A refusal by design is a usage error; a filesystem failure stays internal.
 */
function writeOut(root: string, outRel: string, data: string): void {
  const parent = resolveWritable(root, dirname(outRel));
  if (!parent) throw new UsageError(`Output path is not inside the brain: ${outRel}`);
  const target = join(parent, basename(outRel));
  try {
    if (isInScratch(root, outRel) || isInScratch(root, target)) writeScratchFile(root, outRel, data, { replace: true });
    else writeFileSafely(target, data);
  } catch (error) {
    if (isWriteRefusal(error)) throw new UsageError((error as Error).message);
    throw error;
  }
}

/**
 * `brain eval --lint`: validate the set and report title leakage in its
 * `paraphrase` queries, without scoring. It never opens the index: titles come
 * from the markdown files. A malformed set exits 2 naming the line; findings
 * are warnings and exit 0.
 */
function lintSet(json: boolean, root: string, setPath: string, redact: boolean): number {
  const shown = displayPath(root, setPath);
  const refuse = (reason: string) => {
    console.error(`brain eval refused: ${reason}`);
    return 2;
  };
  if (!existsSync(setPath)) return refuse(`no query set at ${shown}. ${DOCS_POINTER}`);
  const bytes = readFileSync(setPath);
  let queries: EvalQuery[];
  try {
    queries = parseEvalSet(bytes.toString("utf-8")).queries;
  } catch (e) {
    if (e instanceof EvalSetError) {
      return refuse(redact ? `${shown}: line ${e.line}: malformed (withheld by --redact)` : `${shown}: ${e.message}`);
    }
    throw e;
  }
  const titleOf = (path: string): string | null => {
    const full = safeResolve(root, path);
    if (!full || !existsSync(full)) return null;
    try {
      const title = parseFrontmatter(readFileSync(full, "utf-8")).data.title;
      return typeof title === "string" ? title : null;
    } catch {
      return null;
    }
  };
  const found = titleLeaks(queries, titleOf);
  // A finding quotes a title and the query's words, so --redact keeps its count.
  const warnings = redact && found.length > 0 ? [`${found.length} warning(s) withheld by --redact`] : found;
  const envelope = {
    schema_version: EVAL_SCHEMA_VERSION,
    meta: {
      set: redact ? null : shown,
      set_sha256: createHash("sha256").update(bytes).digest("hex"),
      queries: queries.length,
    },
    warnings,
  };
  emit(json, envelope, () => {
    if (warnings.length === 0) console.log(`${redact ? "The set" : shown}: ${queries.length} queries, no lint findings.`);
    else for (const warning of warnings) console.log(`Warning: ${warning}`);
  });
  return 0;
}

export const evalCommand: CoreCommand = {
  summary: "Score a retrieval query set against this brain's index",
  helpBlock: HELP,
  async run(args, cli) {
    // Eval's own exit codes: 1 is a failed baseline gate, so a usage error
    // is 2 here, and a CI job can tell a regression from a misuse. Every
    // other command keeps the CLI's usage-error 1.
    try {
      return await runEval(args, cli);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.error(e.message);
      return 2;
    }
  },
};

async function runEval(args: string[], cli: CliContext): Promise<number> {
  const { args: pos, flags } = parseArgs(args);
  if (pos.length > 0) throw new UsageError(`brain eval takes no positional arguments (got "${pos[0]}")`);

  for (const name of ["set", "out", "mode", "rerank", "k", "now", "budgets", "baseline", "max-net-loss", "must-pass"]) {
    if (flags[name] === true) throw new UsageError(`--${name} requires a value`);
  }

  const modeFlag = typeof flags.mode === "string" ? flags.mode : "hybrid";
  if (!Object.hasOwn(MODES, modeFlag)) {
    throw new UsageError(`--mode must be one of fts, vector, hybrid, all (got "${modeFlag}")`);
  }
  const modes = MODES[modeFlag];
  // The same selection `brain search` makes: --rerank, else BRAIN_RERANK_MODE,
  // else the configured reranker. An explicit jev while disabled or keyless is a
  // warning, which refuses the run below rather than scoring the fallback
  // under jev's name.
  let setup: RerankSetup;
  try {
    setup = rerankSetup(cli.brain.config?.reranker, typeof flags.rerank === "string" ? flags.rerank : undefined);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const rerankFlag = setup.rerank;
  let ks: number[];
  try {
    ks = parseKs(typeof flags.k === "string" ? flags.k : "1,3,10");
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (flags.budgets !== undefined && flags.context !== true) {
    throw new UsageError("--budgets needs --context");
  }
  let budgets: number[] = [];
  if (flags.context === true) {
    try {
      budgets = parseBudgets(typeof flags.budgets === "string" ? flags.budgets : "1000,4000,8000");
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  const baselineFlag = typeof flags.baseline === "string" ? flags.baseline : undefined;
  for (const name of ["max-net-loss", "must-pass", "allow-set-change"]) {
    if (flags[name] !== undefined && baselineFlag === undefined) throw new UsageError(`--${name} needs --baseline`);
  }
  if (baselineFlag !== undefined && !ks.includes(1)) {
    throw new UsageError("--baseline gates on hit@1, so --k must include 1");
  }
  let maxNetLoss = 2;
  if (typeof flags["max-net-loss"] === "string") {
    const raw = flags["max-net-loss"];
    if (!/^[1-9]\d{0,5}$/.test(raw)) throw new UsageError(`--max-net-loss takes a positive integer, got "${raw}"`);
    maxNetLoss = Number(raw);
  }
  const mustPass =
    typeof flags["must-pass"] === "string" ? flags["must-pass"].split(",").map((c) => c.trim()).filter(Boolean) : [];
  if (flags["must-pass"] !== undefined && mustPass.length === 0) {
    throw new UsageError("--must-pass takes one or more classes, comma-separated");
  }
  const redact = flags.redact === true;
  const nowFlag = typeof flags.now === "string" ? flags.now : undefined;
  if (nowFlag !== undefined && !parseEvalDate(nowFlag)) {
    throw new UsageError(`--now takes an ISO date (YYYY-MM-DD) or timestamp, got "${nowFlag}"`);
  }

  const root = cli.brain.root;
  const setPath = resolve(root, typeof flags.set === "string" ? flags.set : join("evals", "retrieval.jsonl"));
  if (flags.lint === true) return lintSet(cli.json, root, setPath, redact);
  // Everything the CLI writes stays inside the brain (integration contract,
  // "Containment"): checked before any search runs, and again at the write.
  const outRel = typeof flags.out === "string" ? flags.out : undefined;
  if (outRel !== undefined && !resolveWritable(root, outRel)) {
    throw new UsageError(`Output path is not inside the brain: ${outRel}`);
  }

  let db: Database | undefined;
  try {
    const { header, queries: written, sha256 } = loadSet(setPath, root, redact);
    // The baseline is read before any search runs, so a missing or
    // unreadable one costs nothing.
    let stored: StoredRun | undefined;
    if (baselineFlag !== undefined) {
      const path = resolve(root, baselineFlag);
      if (!existsSync(path)) throw new EvalRefused(`no baseline at ${displayPath(root, path)}`);
      try {
        stored = parseStoredRun(readFileSync(path, "utf-8"));
      } catch (e) {
        if (e instanceof BaselineError) {
          throw new EvalRefused(`${displayPath(root, path)} is ${redact ? e.summary : e.message}`);
        }
        throw e;
      }
    }
    const { now, warnings: nowWarnings } = resolveNow(header, nowFlag);
    const queries = resolveQueries(cli.brain, written, now);
    db = openReadonlyDb(cli.brain);
    checkExpectedPaths(root, db, queries);
    const scanner = new ContaminationScanner(queries);
    checkIndexFresh(cli.brain, db, scanner);
    const contamination = scanner.warnings();
    if (contamination.length > 0 && flags.strict === true) {
      throw new EvalRefused(`${contamination.length} indexed document(s) contain the set's queries (--strict)`, contamination);
    }
    const warnings = [...nowWarnings, ...contamination];
    // `brain context` always loads the extension; the context eval must
    // see the same search it does.
    if (modes.some((m) => m !== "fts") || budgets.length > 0) await loadVecSupport(db);

    // A requested reranking that cannot run (disabled or keyless jev) would
    // score the fallback under the requested name: refuse, like a degraded lane.
    const requestedRerank = typeof flags.rerank === "string" ? flags.rerank : envRerankMode();
    if (setup.warning && requestedRerank === "jev" && setup.rerank !== "jev") {
      throw new EvalRefused(`${typeof flags.rerank === "string" ? "--rerank jev" : "BRAIN_RERANK_MODE=jev"} cannot run`, [setup.warning]);
    }
    if (setup.warning) warnings.push(setup.warning);
    const pool = poolSize(ks);
    const perQuery: QueryOutcome[] = [];
    const rows: ScoreRow[] = [];
    for (const mode of modes) {
      // The eval measures ranking, not latency: a reranker gets a generous
      // deadline, so a slow call is not scored as a degraded lane.
      const rerankDeps = setup.deps.reranker
        ? { ...setup.deps, rerankTimeoutMs: Math.max(setup.deps.rerankTimeoutMs ?? 0, EVAL_RERANK_TIMEOUT_MS) }
        : {};
      const outcomes = await runMode(db, mode, queries, { rerank: rerankFlag, ks, pool, now }, { embeddings: cli.embeddings, taxonomy: cli.brain.taxonomy, ...rerankDeps });
      perQuery.push(...outcomes);
      rows.push(...aggregate(mode, outcomes, ks));
    }

    const documents = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const meta = {
      version: packageVersion(),
      source: checkoutSource(),
      set: displayPath(root, setPath),
      set_sha256: sha256,
      queries: queries.length,
      documents,
      // The model that embedded this run's queries. hybridSearch refuses a
      // provider that differs from the stored vectors' model, so it names
      // those too. null when no vector lane ran.
      embedding_model: modes.some((m) => m !== "fts") ? (cli.embeddings?.id ?? null) : null,
      modes,
      rerank: rerankFlag,
      // Which judgment reranker ordered the results (with its pinned model),
      // null when none did.
      reranker: setup.deps.reranker?.id ?? null,
      k: ks,
      pool,
      now: now.toISOString(),
    };
    const context =
      budgets.length > 0 ? await runContext(db, cli.brain, queries, budgets, now, cli.embeddings, warnings, {
          ...setup,
          warning: undefined,
          deps: setup.deps.reranker
            ? { ...setup.deps, rerankTimeoutMs: Math.max(setup.deps.rerankTimeoutMs ?? 0, EVAL_RERANK_TIMEOUT_MS) }
            : setup.deps,
        }) : undefined;
    let envelope: Record<string, unknown> = {
      schema_version: EVAL_SCHEMA_VERSION,
      meta,
      rows,
      per_query: perQuery,
      warnings,
      ...(context ? { context } : {}),
    };

    let baseline: BaselineReport | undefined;
    if (stored !== undefined) {
      const current = parseStoredRun(JSON.stringify(envelope));
      baseline = {
        file: displayPath(root, resolve(root, baselineFlag!)),
        ...compareRuns(stored, current, { maxNetLoss, mustPass, allowSetChange: flags["allow-set-change"] === true }),
      };
      envelope.baseline = baseline;
    }
    if (redact) envelope = redactEnvelope(envelope);

    if (outRel !== undefined) writeOut(root, outRel, JSON.stringify(envelope, null, 2) + "\n");
    // The human output reads the same, possibly redacted, envelope as --json,
    // so --redact holds for both.
    const shown = envelope as {
      rows: ScoreRow[];
      per_query: ShownOutcome[];
      meta: Record<string, unknown>;
      warnings: string[];
      baseline?: BaselineReport;
      context?: { rows: ContextRow[] };
    };
    emit(cli.json, envelope, () => {
      printHuman(shown.rows, shown.per_query, ks, shown.meta, shown.warnings);
      if (shown.context) printContext(shown.context);
      if (shown.baseline) printBaseline(shown.baseline);
    });
    // 3: not comparable, which is not a pass. 1: the gate failed.
    if (baseline && !baseline.comparable) return 3;
    if (baseline?.gate.failed) return 1;
    return 0;
  } catch (e) {
    if (!(e instanceof EvalRefused)) throw e;
    console.error(`brain eval refused: ${e.reason}`);
    // A reason carries counts, query IDs and the paths the user passed; the
    // details name documents and quote search warnings.
    if (redact && e.details.length > 0) console.error(`  ${e.details.length} detail(s) withheld by --redact`);
    else for (const detail of e.details) console.error(`  ${detail}`);
    return 2;
  } finally {
    db?.close();
  }
}
