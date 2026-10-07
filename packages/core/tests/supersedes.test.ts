/**
 * `supersedes:` (#412): a newer document names the one it replaces, and search
 * demotes the replaced one in every mode, without hiding it.
 *
 * The superseding document goes into a temp copy of the corpus, so the
 * fixture's pinned counts stay put.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { brainConfigSchema } from "../src/lib/config";
import { migrateVecSchema, openDatabase, setMeta } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { validate } from "../src/lib/validate";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { loadVec } from "./vec-fixture";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

const OLD = "projects/active/raft/plan.md";
const NEW = "projects/active/raft/plan-v2.md";
const QUERY = "auger bulwarks";

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
    .replace('title: "Raft — Build Plan"', 'title: "Raft — Build Plan, revised"')
    .replace("## Cut list", "## Finish\n\nTwo spare ropes beside the mast; inspect every knot before leaving Ogygia.\n\n## Cut list")
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
    // Lose the derived rows; the markdown stays.
    const db = new Database(join(root, "brain.db"));
    db.run("DELETE FROM supersedes");
    db.close();
    expect((await fts(root)).find((h) => h.path === OLD)?.supersededBy).toBeUndefined(); // the precondition
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    const hits = await fts(root);
    expect(hits.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
  }, 120_000);

  test("a filter-only search carries supersededBy, in the CLI and in brain_search", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const r = await runCli(root, ["search", "--type", "project", "--limit", "50", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const listed = JSON.parse(r.stdout).results as Hit[];
    expect(listed.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
    expect(listed.find((h) => h.path === NEW)).toHaveProperty("path", NEW);
    expect(listed.find((h) => h.path === NEW)).not.toHaveProperty("supersededBy");

    const client = new Client({ name: "supersedes-filter-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
    try {
      const res = await client.callTool({ name: "brain_search", arguments: { query: "", type: "project", limit: 50 } });
      const results = (res.structuredContent as { results: Hit[] }).results;
      expect(results.find((h) => h.path === OLD)?.supersededBy).toBe(NEW);
    } finally {
      await client.close();
    }
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
  async function validateRun(root: string): Promise<{ code: number; errors: string[] }> {
    const r = await runCli(root, ["validate", "--json"]);
    const issues = JSON.parse(r.stdout).issues as Array<{ file: string; level: string; message: string }>;
    return {
      code: r.code,
      errors: issues.filter((i) => i.level === "error" && /supersedes/i.test(i.message)).map((i) => `${i.file}: ${i.message}`),
    };
  }

  test("an unresolved target is an error, and validate fails", async () => {
    const { code, errors } = await validateRun(brain('"[[no-such-plan]]"'));
    expect(errors).toEqual([`${NEW}: Unresolved supersedes target: [[no-such-plan]]`]);
    expect(code).not.toBe(0);
  }, 60_000);

  test("a two-document cycle is an error on each document, and validate fails", async () => {
    const root = brain();
    const old = join(root, OLD);
    writeFileSync(old, readFileSync(old, "utf8").replace("relevance: primary", `relevance: primary\nsupersedes: "[[${NEW.replace(/\.md$/, "")}]]"`));
    const { code, errors } = await validateRun(root);
    expect(errors.sort()).toEqual([
      `${NEW}: supersedes cycle among ${NEW}, ${OLD}`,
      `${OLD}: supersedes cycle among ${NEW}, ${OLD}`,
    ]);
    expect(code).not.toBe(0);
  }, 60_000);

  test("a valid supersedes is no error", async () => {
    expect((await validateRun(brain())).errors).toEqual([]);
  }, 60_000);
});

describe("supersedes values validate reads", () => {
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({}) });
  const note = (title: string, supersedes?: string) =>
    ["---", "type: note", `title: ${title}`, ...(supersedes === undefined ? [] : [`supersedes: ${supersedes}`]), "---", "", "Body.", ""].join("\n");
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "brain-supersedes-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const errorsIn = (root: string) =>
    validate(root, taxonomy)
      .filter((i) => i.level === "error" && /supersedes/i.test(i.message))
      .map((i) => `${i.file}: ${i.message}`);

  test("a malformed, empty, null or blank value is an error, as a scalar or in a list", () => {
    const bad = [
      '"[[missing"', '"[[]]"', '""', '"   "', "", "null", '"[[a]] [[b]]"', "[]",
      '["[[missing"]', '["[[]]"]', '[""]', "[null]", '["[[a]]", "  "]', "[3]",
    ];
    for (const value of bad) {
      const root = tree({ "notes/a.md": note("A"), "notes/new.md": note("New", value) });
      const errors = errorsIn(root);
      expect({ value, errors }).toEqual({ value, errors: [expect.stringContaining("notes/new.md: Invalid supersedes")] });
    }
  });

  test("well-formed values are accepted: bare, linked, labelled, and in a list", () => {
    for (const value of ['"[[a]]"', "a", '"[[a|the old one]]"', '["[[a]]", "b"]']) {
      const root = tree({ "notes/a.md": note("A"), "notes/b.md": note("B"), "notes/new.md": note("New", value) });
      expect({ value, errors: errorsIn(root) }).toEqual({ value, errors: [] });
    }
  });

  test("every document on overlapping cycles is reported, whatever the order of its targets", () => {
    for (const targets of ['["[[b]]", "[[c]]"]', '["[[c]]", "[[b]]"]']) {
      const root = tree({ "notes/a.md": note("A", targets), "notes/b.md": note("B", '"[[a]]"'), "notes/c.md": note("C", '"[[a]]"') });
      const errors = errorsIn(root).sort();
      const among = "supersedes cycle among notes/a.md, notes/b.md, notes/c.md";
      expect({ targets, errors }).toEqual({ targets, errors: [`notes/a.md: ${among}`, `notes/b.md: ${among}`, `notes/c.md: ${among}`] });
    }
  });

  test("a document superseding itself is a cycle", () => {
    const root = tree({ "notes/a.md": note("A", '"[[a]]"') });
    expect(errorsIn(root)).toEqual(["notes/a.md: supersedes cycle among notes/a.md"]);
  });
});
