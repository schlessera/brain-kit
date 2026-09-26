/**
 * `supersedes:` (#412): a newer document names the one it replaces, and search
 * demotes the replaced one in every mode, without hiding it.
 *
 * The superseding document goes into a temp copy of the corpus, so the
 * fixture's pinned counts stay put.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { migrateVecSchema, openDatabase, setMeta } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { loadVec } from "./vec-fixture";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

const OLD = "projects/active/bookshelf/plan.md";
const NEW = "projects/active/bookshelf/plan-v2.md";
const QUERY = "dovetails dadoes drawer";

/**
 * A revised plan: the old one's text plus a paragraph on finishing, so the
 * old, shorter plan still matches the query a little better on its own. Same
 * `updated` and relevance, so only supersession tells them apart.
 */
function brain(supersedes: string | null = `"[[${OLD.replace(/\.md$/, "")}]]"`): string {
  const root = makeTempBrain();
  roots.push(root);
  const old = readFileSync(join(root, OLD), "utf8");
  const revised = old
    .replace('title: "Bookshelf — Build Plan"', 'title: "Bookshelf — Build Plan, revised"')
    .replace("## Cut list", "## Finish\n\nTwo coats of hardwax oil on the walnut, the cedar left bare to keep its scent.\n\n## Cut list")
    .replace("relevance: primary", supersedes ? `relevance: primary\nsupersedes: ${supersedes}` : "relevance: primary");
  writeFileSync(join(root, NEW), revised);
  return root;
}

type Hit = { path: string; supersededBy?: string };

async function fts(root: string): Promise<Hit[]> {
  const r = await runCli(root, ["search", QUERY, "--mode", "fts", "--rerank", "none", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout).results;
}

const order = (hits: Hit[]) => hits.map((h) => h.path).filter((p) => p === OLD || p === NEW);

/**
 * The indexed brain with a controlled vector lane: the old plan's chunks sit
 * right on the query vector, the new plan's just off it, nothing else has one.
 */
async function withVectors(root: string): Promise<{ db: Database; provider: EmbeddingProvider }> {
  const db = openDatabase(join(root, "brain.db"));
  // The keyless index made a vector table of the default width; this one is 2-wide.
  await loadVec(db);
  db.run("DROP TABLE IF EXISTS vec_chunks");
  expect(await migrateVecSchema(db, 2)).toBe(true);
  setMeta(db, "embedding_model", "test:supersedes");
  const chunks = db
    .prepare("SELECT c.id, d.path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path IN (?, ?)")
    .all(OLD, NEW) as { id: number; path: string }[];
  expect(chunks.length).toBeGreaterThan(1);
  for (const { id, path } of chunks) {
    const vector = new Float32Array([1, path === OLD ? 0 : 0.05]);
    db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'project')", [id, new Uint8Array(vector.buffer)]);
  }
  const provider: EmbeddingProvider = {
    id: "test:supersedes",
    dimensions: 2,
    embed: async () => [],
    embedQuery: async () => new Float32Array([1, 0]),
  };
  return { db, provider };
}

describe("supersedes", () => {
  test("the premise: without supersedes the old plan ranks first in every mode", async () => {
    const root = brain(null);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect(order(await fts(root))).toEqual([OLD, NEW]);
    const { db, provider } = await withVectors(root);
    for (const mode of ["vector", "hybrid"] as const) {
      const { results } = await hybridSearch(db, { query: QUERY, mode, rerank: "none" }, { embeddings: provider });
      expect({ mode, order: order(results) }).toEqual({ mode, order: [OLD, NEW] });
    }
    db.close();
  }, 120_000);

  test("full-text: the superseding plan ranks first, and the old one stays, carrying supersededBy", async () => {
    const root = brain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const hits = await fts(root);
    expect(order(hits)).toEqual([NEW, OLD]);
    expect(hits.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
    expect(hits.find((h) => h.path === NEW)?.supersededBy).toBeUndefined();
  }, 120_000);

  test("vector: the superseding plan ranks first", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root);
    const { results } = await hybridSearch(db, { query: QUERY, mode: "vector", rerank: "none" }, { embeddings: provider });
    db.close();
    expect(order(results)).toEqual([NEW, OLD]);
  }, 120_000);

  test("hybrid: the superseding plan ranks first, reranked or not", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root);
    for (const rerank of ["none", "heuristic"] as const) {
      const { results } = await hybridSearch(db, { query: QUERY, mode: "hybrid", rerank }, { embeddings: provider });
      expect({ rerank, order: order(results) }).toEqual({ rerank, order: [NEW, OLD] });
    }
    db.close();
  }, 120_000);

  test("brain_search carries supersededBy too", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const client = new Client({ name: "supersedes-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
    try {
      const res = await client.callTool({ name: "brain_search", arguments: { query: QUERY, mode: "fts", rerank: "none" } });
      const results = (res.structuredContent as { results: Hit[] }).results;
      expect(order(results)).toEqual([NEW, OLD]);
      expect(results.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
      expect(results.find((h) => h.path === NEW)).not.toHaveProperty("supersededBy");
    } finally {
      await client.close();
    }
  }, 120_000);

  test("brain index --force rebuilds supersession from the markdown", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    const hits = await fts(root);
    expect(hits.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
  }, 120_000);

  test("an index from before schema 12 gains supersession on its next index run, without --force", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const db = new Database(join(root, "brain.db"));
    db.run("DROP TABLE supersedes");
    db.run("UPDATE index_metadata SET value = '11' WHERE key = 'schema_version'");
    db.close();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect((await fts(root)).find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
  }, 120_000);
});

describe("brain validate on supersedes", () => {
  async function errors(root: string): Promise<string[]> {
    const r = await runCli(root, ["validate", "--json"]);
    const issues = JSON.parse(r.stdout).issues as Array<{ file: string; level: string; message: string }>;
    return issues.filter((i) => i.level === "error" && /supersedes/i.test(i.message)).map((i) => `${i.file}: ${i.message}`);
  }

  test("an unresolved target is an error", async () => {
    const root = brain('"[[no-such-plan]]"');
    expect(await errors(root)).toEqual([`${NEW}: Unresolved supersedes target: [[no-such-plan]]`]);
  }, 60_000);

  test("a two-document cycle is an error on each document", async () => {
    const root = brain();
    const old = join(root, OLD);
    writeFileSync(old, readFileSync(old, "utf8").replace("relevance: primary", `relevance: primary\nsupersedes: "[[${NEW.replace(/\.md$/, "")}]]"`));
    const loop = `supersedes cycle: `;
    const found = await errors(root);
    expect(found).toHaveLength(2);
    expect(found.every((line) => line.includes(loop))).toBe(true);
    expect(found.map((line) => line.split(":")[0]).sort()).toEqual([NEW, OLD].sort());
  }, 60_000);

  test("a valid supersedes is no error", async () => {
    expect(await errors(brain())).toEqual([]);
  }, 60_000);
});
