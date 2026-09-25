import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import matter from "gray-matter";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

import type { BrainContext } from "../../lib/context.js";
import { loadVecSupport } from "../../lib/db.js";
import { getMarkdownFiles } from "../../lib/indexer.js";
import { getDefaultRerankerMode } from "../../lib/reranker.js";
import {
  aggregate,
  EVAL_SCHEMA_VERSION,
  EvalSetError,
  ContaminationScanner,
  parseEvalSet,
  parseKs,
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
import { hybridSearch } from "../../lib/search-engine.js";
import type { EmbeddingProvider } from "../../lib/seams.js";
import { packageRoot, packageVersion } from "../../package-version.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs, UsageError } from "../io.js";

const DOCS_POINTER =
  "See docs/evaluating-search.md (https://github.com/schlessera/brain-kit/blob/main/docs/evaluating-search.md) for the format.";

const HELP = `brain eval — score a retrieval query set against this brain's index

  --set <file>            JSONL query set (default: evals/retrieval.jsonl)
  --mode <mode>           fts|vector|hybrid|all (default: hybrid)
  --rerank <mode>         none|heuristic (default: the search default)
  --k <list>              hit@k cutoffs, comma-separated (default: 1,3,10)
  --out <file>            Also write the JSON result to <file>, inside the brain
  --strict                Refuse (exit 2) when an indexed document quotes the set's queries
  --now <ISO date>        The moment the run measures from, when the set's header
                          does not pin one (default: the wall clock)

Relative paths are relative to the brain root.

Exit codes: 0 scored · 1 usage error or malformed set · 2 refused (a validity
gate failed: missing or empty set, an expected or stale path not on disk or
not indexed, a selector that selects nothing, the index older than the
markdown, a requested search lane degraded; with --strict, an indexed
document that contains the set's queries).

--json envelope: { "schema_version", "meta", "rows", "per_query", "warnings" }
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

function loadSet(path: string, root: string): { header: SetHeader | null; queries: EvalQuery[]; sha256: string } {
  const shown = displayPath(root, path);
  if (!existsSync(path)) {
    throw new EvalRefused(`no query set at ${shown}. ${DOCS_POINTER}`);
  }
  const bytes = readFileSync(path);
  let parsed;
  try {
    parsed = parseEvalSet(bytes.toString("utf-8"));
  } catch (e) {
    if (e instanceof EvalSetError) throw new UsageError(`${shown}: ${e.message}`);
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
        const parsed = matter(readFileSync(join(brain.root, path), "utf-8"));
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
      const { data } = matter(raw);
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

async function runMode(
  db: Database,
  mode: EvalMode,
  queries: ResolvedQuery[],
  opts: { rerank: "none" | "heuristic"; ks: number[]; pool: number; now: Date },
  embeddings: EmbeddingProvider | undefined
): Promise<QueryOutcome[]> {
  const outcomes: QueryOutcome[] = [];
  for (const query of queries) {
    const { results, warnings } = await hybridSearch(
      db,
      { query: query.q, mode, rerank: opts.rerank, limit: opts.pool, now: opts.now },
      { embeddings }
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

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function printHuman(
  rows: ScoreRow[],
  perQuery: QueryOutcome[],
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
      console.log(`  [${o.mode}] ${o.id} (${o.class}): ${where}; top: ${o.top[0] ?? "(nothing)"}`);
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

export const evalCommand: CoreCommand = {
  summary: "Score a retrieval query set against this brain's index",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    if (pos.length > 0) throw new UsageError(`brain eval takes no positional arguments (got "${pos[0]}")`);

    for (const name of ["set", "out", "mode", "rerank", "k", "now"]) {
      if (flags[name] === true) throw new UsageError(`--${name} requires a value`);
    }

    const modeFlag = typeof flags.mode === "string" ? flags.mode : "hybrid";
    if (!Object.hasOwn(MODES, modeFlag)) {
      throw new UsageError(`--mode must be one of fts, vector, hybrid, all (got "${modeFlag}")`);
    }
    const modes = MODES[modeFlag];
    const rerankFlag = typeof flags.rerank === "string" ? flags.rerank : getDefaultRerankerMode();
    if (rerankFlag !== "none" && rerankFlag !== "heuristic") {
      throw new UsageError(`--rerank must be none or heuristic (got "${rerankFlag}")`);
    }
    let ks: number[];
    try {
      ks = parseKs(typeof flags.k === "string" ? flags.k : "1,3,10");
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const nowFlag = typeof flags.now === "string" ? flags.now : undefined;
    if (nowFlag !== undefined && !parseEvalDate(nowFlag)) {
      throw new UsageError(`--now takes an ISO date (YYYY-MM-DD) or timestamp, got "${nowFlag}"`);
    }

    const root = cli.brain.root;
    const setPath = resolve(root, typeof flags.set === "string" ? flags.set : join("evals", "retrieval.jsonl"));
    // Everything the CLI writes stays inside the brain (integration contract,
    // "Containment"): checked before any search runs, and again at the write.
    const outRel = typeof flags.out === "string" ? flags.out : undefined;
    if (outRel !== undefined && !resolveWritable(root, outRel)) {
      throw new UsageError(`Output path is not inside the brain: ${outRel}`);
    }

    let db: Database | undefined;
    try {
      const { header, queries: written, sha256 } = loadSet(setPath, root);
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
      if (modes.some((m) => m !== "fts")) await loadVecSupport(db);

      const pool = poolSize(ks);
      const perQuery: QueryOutcome[] = [];
      const rows: ScoreRow[] = [];
      for (const mode of modes) {
        const outcomes = await runMode(db, mode, queries, { rerank: rerankFlag, ks, pool, now }, cli.embeddings);
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
        k: ks,
        pool,
        now: now.toISOString(),
      };
      const envelope = { schema_version: EVAL_SCHEMA_VERSION, meta, rows, per_query: perQuery, warnings };

      if (outRel !== undefined) writeOut(root, outRel, JSON.stringify(envelope, null, 2) + "\n");
      emit(cli.json, envelope, () => printHuman(rows, perQuery, ks, meta, warnings));
      return 0;
    } catch (e) {
      if (!(e instanceof EvalRefused)) throw e;
      console.error(`brain eval refused: ${e.reason}`);
      for (const detail of e.details) console.error(`  ${detail}`);
      return 2;
    } finally {
      db?.close();
    }
  },
};
