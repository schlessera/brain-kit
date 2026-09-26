/**
 * Keyless retrieval goldens over the fixture corpus.
 *
 * The full-text test runs `brain eval --mode fts` on a temp copy of
 * `fixtures/corpus/` against the committed set `evals/retrieval.jsonl`, and
 * asserts, per query, the rank of the expected path that
 * `evals/expected-ranks.json` records. A ranking change therefore shows up as
 * a reviewed diff to that file: rerun with BRAIN_UPDATE_GOLDENS=1 to rewrite
 * it, and explain the moved ranks in the PR.
 *
 * The hybrid test is separate and says what it is: vectors staged by hand,
 * so it guards the fusion plumbing (two lanes merged into one ranking), never
 * retrieval quality. A 25-document fixture cannot say how good search is;
 * these goldens only make a regression, or an improvement, visible.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { openDatabase } from "../src/lib/db";
import { parseEvalSet } from "../src/lib/retrieval-eval";
import type { EvalQuery } from "../src/lib/retrieval-eval";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { embedTempBrain, loadVec, vecAvailable } from "./vec-fixture";

const CORPUS = resolve(import.meta.dir, "../fixtures/corpus");
const SET_PATH = join(CORPUS, "evals/retrieval.jsonl");
const RANKS_PATH = join(CORPUS, "evals/expected-ranks.json");
const UPDATE = process.env.BRAIN_UPDATE_GOLDENS === "1";

/** Every class the set must cover; the issue that created the set lists them. */
const CLASSES = [
  "exact",
  "question",
  "paraphrase",
  "alias",
  "ambiguous-filename",
  "time",
  "stale-vs-current",
  "no-answer",
  "multi-hop",
  "non-english",
  "recency",
];

/**
 * What each query must reproduce: the rank of its expected path, whether the
 * current path ranks above the stale ones, and, for a no-answer query (whose
 * rank is null by definition), the paths search returns instead.
 */
type Golden = { rank: number | null; current_first?: boolean; top?: string[] };
type Outcome = {
  id: string;
  class: string;
  expected: string[];
  rank: number | null;
  current_first: boolean | null;
  top: string[];
};

/** How many of a no-answer query's results its golden pins. */
const NO_ANSWER_TOP = 3;

const { header, queries } = parseEvalSet(readFileSync(SET_PATH, "utf-8"));
const goldens: Record<string, Golden> = existsSync(RANKS_PATH) ? JSON.parse(readFileSync(RANKS_PATH, "utf-8")) : {};

describe("the fixture query set", () => {
  test("covers every class, pins now, and gives every answerable query an answer that exists", () => {
    expect(header?.now).toBe("2026-07-12");
    expect([...new Set(queries.map((q) => q.class))].sort()).toEqual([...CLASSES].sort());
    for (const query of queries) {
      if (query.class === "no-answer") {
        expect(query.expected).toEqual([]);
        continue;
      }
      // A selector's answer is resolved at run time; the run refuses one
      // that selects nothing, and the golden test below asserts its rank.
      if (query.expect) continue;
      expect(query.expected!.length, query.id).toBeGreaterThan(0);
      for (const path of [...query.expected!, ...(query.stale ?? [])]) {
        expect(existsSync(join(CORPUS, path)), `${query.id}: ${path}`).toBe(true);
      }
    }
  });

  test("records a golden for exactly the set's queries", () => {
    if (UPDATE) return;
    expect(Object.keys(goldens).sort()).toEqual(queries.map((q) => q.id).sort());
  });
});

describe("full-text ranks (keyless goldens)", () => {
  let root: string;
  let outcomes: Map<string, Outcome>;

  beforeAll(async () => {
    root = makeTempBrain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    // The reranker is named, not inherited: BRAIN_RERANK_MODE in the
    // environment would otherwise change the ranks a run and a regeneration see.
    const run = await runCli(root, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    outcomes = new Map((out.per_query as Outcome[]).map((o) => [o.id, o]));

    // One line a ranking PR can paste before and after.
    const overall = out.rows.find((r: { class: string | null }) => r.class === null);
    const perClass = out.rows
      .filter((r: { class: string | null; hit_at: unknown }) => r.class !== null && r.hit_at !== null)
      .map((r: { class: string; hit_at: Record<string, number>; n: number }) => `${r.class} ${Math.round(r.hit_at["1"] * r.n)}/${r.n}`)
      .join(", ");
    console.log(
      `retrieval goldens (fts, rerank heuristic, now ${header?.now}): hit@1 ${overall.hit_at["1"].toFixed(3)}, ` +
        `MRR@10 ${overall.mrr_at_10.toFixed(3)}, n ${overall.n} | ${perClass}`
    );

    if (UPDATE) {
      const next: Record<string, Golden> = {};
      for (const query of queries) {
        const o = outcomes.get(query.id)!;
        next[query.id] =
          query.class === "no-answer"
            ? { rank: o.rank, top: o.top.slice(0, NO_ANSWER_TOP) }
            : o.current_first === null
              ? { rank: o.rank }
              : { rank: o.rank, current_first: o.current_first };
      }
      writeFileSync(RANKS_PATH, JSON.stringify(next, null, 2) + "\n");
      console.log(`rewrote ${RANKS_PATH}`);
    }
  });

  afterAll(() => cleanup(root));

  test.each(queries.map((q): [string, EvalQuery] => [q.id, q]))("%s ranks where the golden says", (id) => {
    const outcome = outcomes.get(id);
    expect(outcome, `${id} was not scored`).toBeDefined();
    const golden = UPDATE ? goldens[id] ?? { rank: outcome!.rank } : goldens[id];
    expect(golden, `${id} has no golden; run with BRAIN_UPDATE_GOLDENS=1`).toBeDefined();
    if (UPDATE) return;
    expect({ id, rank: outcome!.rank }).toEqual({ id, rank: golden.rank });
    if (golden.current_first !== undefined) {
      expect({ id, current_first: outcome!.current_first }).toEqual({ id, current_first: golden.current_first });
    }
    if (golden.top !== undefined) {
      expect({ id, top: outcome!.top.slice(0, NO_ANSWER_TOP) }).toEqual({ id, top: golden.top });
    }
  });

  test("every no-answer query pins the results it gets instead", () => {
    if (UPDATE) return;
    for (const query of queries.filter((q) => q.class === "no-answer")) {
      expect(goldens[query.id]?.top, query.id).toBeDefined();
      expect(goldens[query.id].top!.length, query.id).toBeGreaterThan(0);
    }
  });

  test("a selector resolves to the document its frontmatter names", () => {
    expect(outcomes.get("time-due-next")?.expected).toEqual(["projects/active/bookshelf/status.md"]);
    expect(outcomes.get("time-review")?.expected).toEqual(["context/current-focus.md"]);
  });
});

/**
 * Fusion plumbing: two lanes merged into one ranking. The vectors are staged
 * by hand, one direction per document, and each query's vector puts the
 * documents in a chosen order, so the vector lane's ranking is known exactly
 * and the fused ranks follow from the fusion rule alone. This says nothing
 * about retrieval quality.
 */
describe.skipIf(!vecAvailable)("hybrid fusion plumbing (staged vectors)", () => {
  const DIMENSIONS = 32;
  const NOW = new Date("2026-07-12T00:00:00Z");
  let root: string;
  let db: Database;
  let paths: string[];

  // The vector lane's order per query, shared by the direct tests and the
  // provider the spawned `brain eval` loads from the temp brain's config.
  const KNEE_ORDER = ["health/sleep-tracking.md", "health/knee-injury.md"];
  const WOOD_ORDER = ["health/checkup-log.md", "journal/2026-06-15.md", "projects/active/trail-signage/status.md"];
  const KNEE_FUSED = ["health/knee-injury.md", "context/current-focus.md", "health/sleep-tracking.md"];
  const WOOD_FUSED = ["projects/active/trail-signage/status.md", "_index.md", "context/current-focus.md"];

  /**
   * A query vector that ranks the documents in `order` first, then every
   * other one, fading: each document owns one axis. Kept as source text so
   * the spawned CLI's provider computes exactly the same vector.
   */
  const VECTOR_FOR = `(order, paths, dimensions) => {
    const v = new Float32Array(dimensions);
    const ranked = [...order, ...paths.filter((p) => !order.includes(p))];
    ranked.forEach((path, i) => { v[paths.indexOf(path)] = 1 / (1 + i); });
    return v;
  }`;
  const vectorFor = (order: string[]): Float32Array =>
    (new Function(`return ${VECTOR_FOR}`)() as (o: string[], p: string[], d: number) => Float32Array)(order, paths, DIMENSIONS);

  function provider(order: string[]): EmbeddingProvider {
    return {
      id: `fake:${DIMENSIONS}`,
      dimensions: DIMENSIONS,
      embed: async (texts) => texts.map(() => new Float32Array(DIMENSIONS)),
      embedQuery: async () => vectorFor(order),
    };
  }

  async function fused(query: string, vectorOrder: string[]): Promise<string[]> {
    const { results, warnings } = await hybridSearch(
      db,
      { query, mode: "hybrid", rerank: "none", limit: 20, now: NOW },
      { embeddings: provider(vectorOrder) }
    );
    expect(warnings).toEqual([]);
    return results.map((r) => r.path);
  }

  beforeAll(async () => {
    root = makeTempBrain();
    await embedTempBrain(root, { dimensions: DIMENSIONS });
    db = openDatabase(join(root, "brain.db"));
    await loadVec(db);
    // Replace the fake provider's constant vectors: every chunk of a document
    // points along that document's own axis.
    paths = (db.prepare("SELECT path FROM documents ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    expect(paths.length).toBeLessThanOrEqual(DIMENSIONS);
    const chunks = db
      .prepare("SELECT c.id, d.path, d.status, d.type FROM chunks c JOIN documents d ON d.id = c.document_id")
      .all() as { id: number; path: string; status: string; type: string }[];
    expect(chunks.length).toBeGreaterThan(0);
    db.run("DELETE FROM vec_chunks");
    const insert = db.prepare("INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, ?, ?)");
    for (const chunk of chunks) {
      const axis = new Float32Array(DIMENSIONS);
      axis[paths.indexOf(chunk.path)] = 1;
      insert.run(chunk.id, new Uint8Array(axis.buffer), chunk.status === "archived" ? 1 : 0, chunk.type);
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");

    // The spawned `brain eval` resolves its provider from brain.config, which
    // takes a custom provider value as-is: give this temp brain one that
    // embeds each test query the way the direct tests do.
    const orders = { "knee injury": KNEE_ORDER, "woodworking project": WOOD_ORDER };
    writeFileSync(
      join(root, "staged-provider.ts"),
      `const vectorFor = ${VECTOR_FOR};\n` +
        `const paths = ${JSON.stringify(paths)};\n` +
        `const orders = ${JSON.stringify(orders)};\n` +
        `export const stagedProvider = {\n` +
        `  id: "fake:${DIMENSIONS}", dimensions: ${DIMENSIONS},\n` +
        `  embed: async (texts) => texts.map(() => new Float32Array(${DIMENSIONS})),\n` +
        `  embedQuery: async (text) => vectorFor(orders[text] ?? [], paths, ${DIMENSIONS}),\n` +
        `};\n`
    );
    const config = join(root, "brain.config.ts");
    const source = readFileSync(config, "utf-8");
    expect(source).toContain("export default defineConfig({");
    expect(source).not.toContain("embeddings:");
    writeFileSync(
      config,
      `import { stagedProvider } from "./staged-provider.ts";\n` +
        source.replace("export default defineConfig({", "export default defineConfig({\n  embeddings: { provider: stagedProvider },")
    );
  });

  afterAll(() => {
    db?.close();
    cleanup(root);
  });

  // "knee injury" matches six documents as text: a thin pool (under half of
  // limit 20), so the text lane's weight drops to 0.05. Vector puts
  // sleep-tracking first and knee-injury second. Summed, knee-injury (text 1
  // + vector 2) passes sleep-tracking (vector 1 alone), and current-focus
  // (text 3 + vector 4) edges past it too. A fusion that kept each
  // document's best lane instead of the sum would put sleep-tracking first.
  test("thin text pool: agreement still edges out one lane's first place", async () => {
    const ranked = await fused("knee injury", KNEE_ORDER);
    expect(ranked.slice(0, 3)).toEqual(KNEE_FUSED);
  });

  // "woodworking project" matches twelve documents as text, so the text lane
  // keeps its full weight 0.8. Text ranks trail-signage/status first; vector
  // ranks it third, behind two documents text never found. Summed (0.8/61 +
  // 1/63) it leads, and at full weight every document both lanes found (the
  // query vector ranks the whole corpus) passes checkup-log's vector first
  // place alone. Each document's best lane alone would put checkup-log first.
  test("full-weight text: documents both lanes found outrank vector's first place alone", async () => {
    const ranked = await fused("woodworking project", WOOD_ORDER);
    expect(ranked.slice(0, 3)).toEqual(WOOD_FUSED);
    expect(ranked.indexOf("health/checkup-log.md")).toBeGreaterThan(2);
  });

  // The same fusion, through `brain eval --mode hybrid`: the spawned CLI loads
  // the staged provider from brain.config, so this breaks when eval stops
  // routing hybrid runs, stops loading the vector extension, or scores the
  // full-text fallback instead.
  test("brain eval --mode hybrid scores the same fused ranks", async () => {
    const set = join(root, "evals", "hybrid.jsonl");
    writeFileSync(
      set,
      [
        { now: "2026-07-12" },
        { id: "knee", q: "knee injury", class: "thin", expected: ["health/knee-injury.md"] },
        { id: "wood", q: "woodworking project", class: "full", expected: ["projects/active/trail-signage/status.md"] },
      ].map((l) => JSON.stringify(l)).join("\n")
    );
    const run = await runCli(root, ["eval", "--set", set, "--mode", "hybrid", "--rerank", "none", "--json"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.meta).toMatchObject({ modes: ["hybrid"], embedding_model: `fake:${DIMENSIONS}` });
    const byId = new Map(out.per_query.map((o: Outcome) => [o.id, o]));
    expect((byId.get("knee") as Outcome).top.slice(0, 3)).toEqual(KNEE_FUSED);
    expect((byId.get("wood") as Outcome).top.slice(0, 3)).toEqual(WOOD_FUSED);
    expect([(byId.get("knee") as Outcome).rank, (byId.get("wood") as Outcome).rank]).toEqual([1, 1]);
  });

  test("a document only the vector lane finds still ranks", async () => {
    const ranked = await fused("knee injury", ["notes/loose-idea.md"]);
    expect(ranked).toContain("notes/loose-idea.md");
    expect(ranked).toContain("health/knee-injury.md");
  });
});
