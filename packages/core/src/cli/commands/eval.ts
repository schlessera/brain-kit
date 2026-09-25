import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import matter from "gray-matter";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

import type { BrainContext } from "../../lib/context.js";
import { loadVecSupport } from "../../lib/db.js";
import { getMarkdownFiles } from "../../lib/indexer.js";
import { getDefaultRerankerMode } from "../../lib/reranker.js";
import {
  aggregate,
  EVAL_SCHEMA_VERSION,
  EvalSetError,
  parseEvalSet,
  parseKs,
  poolSize,
  scoreQuery,
} from "../../lib/retrieval-eval.js";
import type { EvalMode, EvalQuery, QueryOutcome, ScoreRow } from "../../lib/retrieval-eval.js";
import { safeResolve } from "../../lib/safe-path.js";
import { hybridSearch } from "../../lib/search-engine.js";
import type { EmbeddingProvider } from "../../lib/seams.js";
import { packageRoot, packageVersion } from "../../package-version.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs, UsageError } from "../io.js";

const DOCS_POINTER =
  "See docs/evaluating-search.md (https://github.com/schlessera/brain-kit/blob/main/docs/evaluating-search.md) for the format.";

const HELP = `brain eval — score a retrieval query set against this brain's index

  --set <file>            JSONL query set (default: evals/retrieval.jsonl under the brain root)
  --mode <mode>           fts|vector|hybrid|all (default: hybrid)
  --rerank <mode>         none|heuristic (default: the search default)
  --k <list>              hit@k cutoffs, comma-separated (default: 1,3,10)
  --out <file>            Also write the JSON result to <file>

Exit codes: 0 scored · 1 usage error or malformed set · 2 refused (a validity
gate failed: missing or empty set, an expected path not on disk or not indexed,
the index older than the markdown, a requested search lane degraded).

--json envelope: { "schema_version", "meta", "rows", "per_query", "warnings" }
Set format and how to read the numbers: docs/evaluating-search.md`;

const MODES: Record<string, EvalMode[]> = {
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

function loadSet(path: string, root: string): { queries: EvalQuery[]; sha256: string } {
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
  return { queries: parsed.queries, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Every expected path must be a file inside the brain that the index holds. */
function checkExpectedPaths(root: string, db: Database, queries: EvalQuery[]): void {
  const indexed = db.prepare("SELECT 1 FROM documents WHERE path = ?");
  const missing: string[] = [];
  const unindexed: string[] = [];
  for (const query of queries) {
    for (const path of query.expected) {
      const full = safeResolve(root, path);
      if (!full || !existsSync(full)) missing.push(`${query.id}: ${path}`);
      else if (!indexed.get(path)) unindexed.push(`${query.id}: ${path}`);
    }
  }
  if (missing.length > 0) {
    throw new EvalRefused(`${missing.length} expected path(s) do not exist in the brain`, missing);
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
 * the indexer would skip (no title/type) is not reported as unindexed.
 */
function checkIndexFresh(brain: BrainContext, db: Database): void {
  const rows = db
    .prepare("SELECT path, content_hash FROM documents WHERE asset_type = 'markdown'")
    .all() as { path: string; content_hash: string | null }[];
  const hashes = new Map(rows.map((r) => [r.path, r.content_hash]));
  const stale: string[] = [];

  const onDisk = getMarkdownFiles(brain.root, brain.taxonomy);
  for (const path of onDisk) {
    let raw: string;
    try {
      raw = readFileSync(join(brain.root, path), "utf-8");
    } catch {
      continue;
    }
    if (hashes.has(path)) {
      if (hashes.get(path) !== createHash("sha256").update(raw).digest("hex")) {
        stale.push(`${path}: changed since it was indexed`);
      }
      continue;
    }
    try {
      const { data } = matter(raw);
      if (data.title && data.type) stale.push(`${path}: not indexed yet`);
    } catch {
      /* invalid frontmatter: the indexer skips it too */
    }
  }
  const present = new Set(onDisk);
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
  queries: EvalQuery[],
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

function printHuman(rows: ScoreRow[], perQuery: QueryOutcome[], ks: number[], meta: Record<string, unknown>): void {
  console.log(`brain eval — ${meta.queries} queries, ${meta.documents} documents, now ${meta.now}\n`);
  const header = ["mode", "class", "n", ...ks.map((k) => `hit@${k}`), "MRR@10", "oracle", "top1 median"];
  const table = rows.map((r) => [
    r.mode,
    r.class ?? "(all answerable)",
    String(r.n),
    ...ks.map((k) => pct(r.hit_at?.[String(k)] ?? null)),
    r.mrr_at_10 === null ? "-" : r.mrr_at_10.toFixed(3),
    pct(r.oracle),
    r.top1_score_median === null ? "-" : r.top1_score_median.toPrecision(3),
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

export const evalCommand: CoreCommand = {
  summary: "Score a retrieval query set against this brain's index",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    if (pos.length > 0) throw new UsageError(`brain eval takes no positional arguments (got "${pos[0]}")`);

    const modeFlag = typeof flags.mode === "string" ? flags.mode : "hybrid";
    const modes = MODES[modeFlag];
    if (!modes) throw new UsageError(`--mode must be one of fts, vector, hybrid, all (got "${modeFlag}")`);
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
    for (const name of ["set", "out"]) {
      if (flags[name] === true) throw new UsageError(`--${name} takes a file path`);
    }

    const root = cli.brain.root;
    const setPath =
      typeof flags.set === "string" ? resolve(flags.set) : join(root, "evals", "retrieval.jsonl");
    const outPath = typeof flags.out === "string" ? resolve(flags.out) : undefined;

    let db: Database | undefined;
    try {
      const { queries, sha256 } = loadSet(setPath, root);
      db = openReadonlyDb(cli.brain);
      checkExpectedPaths(root, db, queries);
      checkIndexFresh(cli.brain, db);
      if (modes.some((m) => m !== "fts")) await loadVecSupport(db);

      const now = new Date();
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
      const envelope = { schema_version: EVAL_SCHEMA_VERSION, meta, rows, per_query: perQuery, warnings: [] as string[] };

      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n");
      }
      emit(cli.json, envelope, () => printHuman(rows, perQuery, ks, meta));
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
