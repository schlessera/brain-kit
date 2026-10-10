/**
 * Measure a link-graph ranking signal on the keyless retrieval goldens (#419).
 *
 * The question: should a document one link away from the current-focus
 * document rank higher? The maintainer's ruling is "not now; neighbours reach
 * an agent through context (#418)". This script is the evidence, so the
 * question does not come back without it.
 *
 * It copies `packages/core/fixtures/corpus/` to a temp directory, indexes it,
 * and runs every query of `evals/retrieval.jsonl` through `hybridSearch` the
 * way `brain eval --mode fts --rerank heuristic` does. Then it re-ranks each
 * result list with a multiplicative boost on the documents within one hop of
 * the current-focus document (a link in either direction). The boost is applied
 * to the final score, after the reranker, which is where a shipped boost would
 * sit, so it would apply the same way in every mode. Each factor is scored per
 * class against the unboosted baseline, for two neighbour sets: every one-hop
 * document, and the same without directory anchors (`_index.md`). The second
 * is the one-hop version of the rejected third option, which drops the
 * structural links to `_index.md` from the ranking graph.
 *
 * The baseline must reproduce `evals/expected-ranks.json` exactly (the same
 * query IDs and every pinned field; see `goldenDrift`), or the script refuses
 * to report, so the numbers are the goldens' own ranking.
 *
 * Keyless and deterministic: full-text lane only, clock pinned by the set's
 * header. The vector and hybrid lanes need an embedding provider and are not
 * measured; see the decision record for what that leaves open.
 *
 *   bun scripts/measure-graph-boost.ts             # markdown report on stdout
 *   bun scripts/measure-graph-boost.ts --json      # the raw numbers
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseFrontmatter } from "../packages/common/src/frontmatter-parse";

import { initContext } from "../packages/core/src/lib/context.js";
import { openDatabase } from "../packages/core/src/lib/db.js";
import { getMarkdownFiles } from "../packages/core/src/lib/indexer/scan.js";
import {
  aggregate,
  MIN_POOL,
  parseEvalSet,
  scoreQuery,
  selectPaths,
  type QueryOutcome,
  type ResolvedQuery,
} from "../packages/core/src/lib/retrieval-eval.js";
import { hybridSearch } from "../packages/core/src/lib/search-engine.js";
import type { SearchResult } from "../packages/core/src/lib/types.js";

const ROOT = resolve(import.meta.dir, "..");
const CORPUS = join(ROOT, "packages/core/fixtures/corpus");
const BRAIN_BIN = join(ROOT, "packages/core/src/cli/brain.ts");
const FACTORS = [1.1, 1.25, 1.5, 2];
const KS = [1, 3, 10];

/** Re-rank `results` with `factor` applied to the scores of `boosted` paths. Stable for ties. */
export function boost(results: SearchResult[], boosted: Set<string>, factor: number): SearchResult[] {
  return results
    .map((r, i) => ({ r: { ...r, score: boosted.has(r.path) ? r.score * factor : r.score }, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r);
}

/** A pinned golden, as `packages/core/tests/eval-corpus.test.ts` records it. */
export type Golden = { rank: number | null; current_first?: boolean; top?: string[] };

/**
 * Every way `baseline` fails to reproduce `goldens`, checked the way the
 * golden test checks it: the same query IDs, and per query the rank, plus
 * `current_first` and the pinned `top` where the golden records them. Empty
 * when the baseline is the goldens' own ranking.
 */
export function goldenDrift(baseline: QueryOutcome[], goldens: Record<string, Golden>): string[] {
  const problems: string[] = [];
  const ids = new Set(baseline.map((b) => b.id));
  for (const id of Object.keys(goldens)) if (!ids.has(id)) problems.push(`${id}: in the goldens but not measured`);
  for (const b of baseline) {
    const golden = goldens[b.id];
    if (!golden) {
      problems.push(`${b.id}: measured but has no golden`);
      continue;
    }
    if (golden.rank !== b.rank) problems.push(`${b.id}: rank ${b.rank} (golden ${golden.rank})`);
    if (golden.current_first !== undefined && golden.current_first !== b.current_first) {
      problems.push(`${b.id}: current_first ${b.current_first} (golden ${golden.current_first})`);
    }
    if (golden.top !== undefined) {
      const top = b.top.slice(0, golden.top.length);
      if (top.join("\n") !== golden.top.join("\n")) problems.push(`${b.id}: top ${JSON.stringify(top)} (golden ${JSON.stringify(golden.top)})`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const root = mkdtempSync(join(tmpdir(), "brain-graph-boost-"));
  try {
    cpSync(CORPUS, root, { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    const index = Bun.spawnSync(["bun", BRAIN_BIN, "index", "--json"], { env: { ...process.env, BRAIN_ROOT: root } });
    if (index.exitCode !== 0) throw new Error(`brain index failed: ${new TextDecoder().decode(index.stderr)}`);

    const brain = await initContext({ root });
    const db = openDatabase(brain.dbPath, { readonly: true });
    const { header, queries } = parseEvalSet(readFileSync(join(CORPUS, "evals/retrieval.jsonl"), "utf-8"));
    const now = new Date(header!.now!);

    // Selectors resolve against the markdown on disk, as `brain eval` does.
    const documents = getMarkdownFiles(root, brain.taxonomy).map((path) => {
      const parsed = parseFrontmatter(readFileSync(join(root, path), "utf-8"));
      return { path, data: parsed.data, raw: parsed.matter };
    });
    const resolved: ResolvedQuery[] = queries.map((q) =>
      q.expect ? { ...q, expected: selectPaths(q.expect.select, documents, now) } : { ...q, expected: q.expected! }
    );

    const focus = brain.taxonomy.canonicalPath("currentFocus")!;
    const neighbours = new Set(
      (
        db
          .prepare(
            `SELECT t.path AS path FROM links l JOIN documents s ON s.id = l.source_id JOIN documents t ON t.id = l.target_id
               WHERE s.path = ?1 AND t.path != ?1
             UNION
             SELECT s.path AS path FROM links l JOIN documents s ON s.id = l.source_id JOIN documents t ON t.id = l.target_id
               WHERE t.path = ?1 AND s.path != ?1`
          )
          .all(focus) as { path: string }[]
      ).map((r) => r.path)
    );

    const anchors = new Set(brain.taxonomy.dirAnchors);
    const sets: Record<string, Set<string>> = {
      "one-hop": neighbours,
      "one-hop, no _index.md": new Set([...neighbours].filter((p) => !anchors.has(p.split("/").pop()!))),
    };
    const baseline: QueryOutcome[] = [];
    const arms = new Map<string, QueryOutcome[]>();
    for (const set of Object.keys(sets)) for (const f of FACTORS) arms.set(`${set} ×${f}`, []);
    for (const query of resolved) {
      const { results, warnings } = await hybridSearch(
        db,
        { query: query.q, mode: "fts", rerank: "heuristic", limit: MIN_POOL, now },
        { taxonomy: brain.taxonomy }
      );
      if (warnings.length > 0) throw new Error(`${query.id}: ${warnings.join("; ")}`);
      baseline.push(scoreQuery("fts", query, results, KS));
      for (const [set, paths] of Object.entries(sets)) {
        for (const f of FACTORS) arms.get(`${set} ×${f}`)!.push(scoreQuery("fts", query, boost(results, paths, f), KS));
      }
    }
    db.close();

    const goldens = JSON.parse(readFileSync(join(CORPUS, "evals/expected-ranks.json"), "utf-8")) as Record<string, Golden>;
    const drift = goldenDrift(baseline, goldens);
    if (drift.length > 0) throw new Error(`the baseline does not reproduce the goldens: ${drift.join("; ")}`);

    const rows = (outcomes: QueryOutcome[]) => aggregate("fts", outcomes, KS);
    const report = {
      now: header!.now,
      focus,
      neighbours: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()])),
      factors: FACTORS,
      baseline: rows(baseline),
      boosted: Object.fromEntries([...arms].map(([arm, outcomes]) => [arm, rows(outcomes)])),
      moved: [...arms].map(([arm, outcomes]) => ({
        arm,
        queries: baseline
          .map((b, i) => ({ id: b.id, class: b.class, from: b.rank, to: outcomes[i].rank, top: outcomes[i].top.slice(0, 3) }))
          .filter((m) => m.from !== m.to),
      })),
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "-" : v.toFixed(3));
    const classes = report.baseline.filter((r) => r.hit_at !== null).map((r) => r.class);
    console.log(`Focus: ${focus}`);
    for (const [set, paths] of Object.entries(report.neighbours)) console.log(`- ${set}: ${paths.join(", ")}`);
    for (const set of Object.keys(sets)) {
      console.log(`\n**${set}**, hit@1 / MRR@10:\n`);
      console.log(`| class | n | baseline | ${FACTORS.map((f) => `×${f}`).join(" | ")} |`);
      console.log(`| --- | --- | --- | ${FACTORS.map(() => "---").join(" | ")} |`);
      for (const cls of classes) {
        const base = report.baseline.find((r) => r.class === cls)!;
        const cells = FACTORS.map((f) => {
          const row = report.boosted[`${set} ×${f}`].find((r) => r.class === cls)!;
          return `${fmt(row.hit_at!["1"])} / ${fmt(row.mrr_at_10)}`;
        });
        console.log(`| ${cls ?? "all"} | ${base.n} | ${fmt(base.hit_at!["1"])} / ${fmt(base.mrr_at_10)} | ${cells.join(" | ")} |`);
      }
    }
    console.log("\nRanks that moved (baseline → boosted):\n");
    for (const { arm, queries: moved } of report.moved) {
      console.log(`- ${arm}: ${moved.length === 0 ? "none" : moved.map((m) => `${m.id} ${m.from ?? "-"}→${m.to ?? "-"}`).join(", ")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
