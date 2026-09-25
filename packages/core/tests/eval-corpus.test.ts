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

type Golden = { rank: number | null; current_first?: boolean };
type Outcome = { id: string; class: string; expected: string[]; rank: number | null; current_first: boolean | null };

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
    const run = await runCli(root, ["eval", "--mode", "fts", "--json"]);
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
      `retrieval goldens (fts, now ${header?.now}): hit@1 ${overall.hit_at["1"].toFixed(3)}, ` +
        `MRR@10 ${overall.mrr_at_10.toFixed(3)}, n ${overall.n} | ${perClass}`
    );

    if (UPDATE) {
      const next: Record<string, Golden> = {};
      for (const query of queries) {
        const o = outcomes.get(query.id)!;
        next[query.id] = o.current_first === null ? { rank: o.rank } : { rank: o.rank, current_first: o.current_first };
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

  /** A unit vector along each document's own axis, in `order`, then every other document, fading. */
  function vectorFor(order: string[]): Float32Array {
    const v = new Float32Array(DIMENSIONS);
    const ranked = [...order, ...paths.filter((p) => !order.includes(p))];
    ranked.forEach((path, i) => {
      v[paths.indexOf(path)] = 1 / (1 + i);
    });
    return v;
  }

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
    const ranked = await fused("knee injury", ["health/sleep-tracking.md", "health/knee-injury.md"]);
    expect(ranked.slice(0, 3)).toEqual([
      "health/knee-injury.md",
      "context/current-focus.md",
      "health/sleep-tracking.md",
    ]);
  });

  // "woodworking project" matches twelve documents as text, so the text lane
  // keeps its full weight 0.8. Text ranks trail-signage/status first; vector
  // ranks it third, behind two documents text never found. Summed (0.8/61 +
  // 1/63) it leads, and at full weight every document both lanes found (the
  // query vector ranks the whole corpus) passes checkup-log's vector first
  // place alone. Each document's best lane alone would put checkup-log first.
  test("full-weight text: documents both lanes found outrank vector's first place alone", async () => {
    const ranked = await fused("woodworking project", [
      "health/checkup-log.md",
      "journal/2026-06-15.md",
      "projects/active/trail-signage/status.md",
    ]);
    expect(ranked.slice(0, 3)).toEqual([
      "projects/active/trail-signage/status.md",
      "_index.md",
      "context/current-focus.md",
    ]);
    expect(ranked.indexOf("health/checkup-log.md")).toBeGreaterThan(2);
  });

  test("a document only the vector lane finds still ranks", async () => {
    const ranked = await fused("knee injury", ["notes/loose-idea.md"]);
    expect(ranked).toContain("notes/loose-idea.md");
    expect(ranked).toContain("health/knee-injury.md");
  });
});
