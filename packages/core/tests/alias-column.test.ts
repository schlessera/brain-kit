/**
 * An alias is a first-class match (#416): its own full-text column weighted
 * like the title, and a query that is exactly a document's title or alias
 * puts that document first in `fts` and `hybrid`.
 *
 * Extra documents go into a temp copy of the corpus, so the fixture's pinned
 * counts stay put.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { migrateVecSchema, openDatabase, setMeta } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { loadVec } from "./vec-fixture";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

const SCOPE = "studies/telescope-setup.md"; // aliases: "my scope", "the Dobsonian", "the lightbucket"
const DIARY = "notes/scope-diary.md";

/** A log that says "scope" in its title and "my scope" over and over in its body, and carries a tag no text uses. */
const DIARY_TEXT = [
  "---",
  "type: note",
  "title: Scope Log",
  'created: "2026-01-01"',
  'updated: "2026-01-02"',
  "tags: [zenithal]",
  "---",
  "",
  "Took my scope out at dusk. My scope needed a cool-down, so my scope sat on the deck for an hour.",
  "Next time my scope goes to the ridge; my scope is lighter than it looks.",
  "",
].join("\n");

function brain(): string {
  const root = makeTempBrain();
  roots.push(root);
  writeFileSync(join(root, DIARY), DIARY_TEXT);
  return root;
}

async function paths(root: string, ...args: string[]): Promise<string[]> {
  const r = await runCli(root, ["search", ...args, "--limit", "20", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return (JSON.parse(r.stdout).results as Array<{ path: string }>).map((x) => x.path);
}

/** The indexed brain with a controlled vector lane: `nearest`'s chunks on the query vector, the other's off it. */
async function withVectors(root: string, nearest: string): Promise<{ db: Database; provider: EmbeddingProvider }> {
  const db = openDatabase(join(root, "brain.db"));
  // The keyless index made a vector table of the default width; this one is 2-wide.
  await loadVec(db);
  db.run("DROP TABLE IF EXISTS vec_chunks");
  expect(await migrateVecSchema(db, 2)).toBe(true);
  setMeta(db, "embedding_model", "test:alias");
  const chunks = db
    .prepare("SELECT c.id, d.path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path IN (?, ?)")
    .all(SCOPE, DIARY) as { id: number; path: string }[];
  for (const { id, path } of chunks) {
    const vector = new Float32Array([1, path === nearest ? 0 : 0.5]);
    db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'note')", [id, new Uint8Array(vector.buffer)]);
  }
  const provider: EmbeddingProvider = { id: "test:alias", dimensions: 2, embed: async () => [], embedQuery: async () => new Float32Array([1, 0]) };
  return { db, provider };
}

describe("an exact alias", () => {
  test("ranks its document first under --mode fts, above one that says the phrase in its title and body", async () => {
    const root = brain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const found = await paths(root, "my scope", "--mode", "fts");
    expect(found).toContain(DIARY);
    expect(found[0]).toBe(SCOPE);
  }, 120_000);

  test("ranks its document first under hybrid, when the vector lane ranks another first", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root, DIARY);

    const vector = await hybridSearch(db, { query: "my scope", mode: "vector", rerank: "none" }, { embeddings: provider });
    expect(vector.results[0]?.path).toBe(DIARY); // the premise
    for (const rerank of ["none", "heuristic"] as const) {
      const { results } = await hybridSearch(db, { query: "My  Scope", mode: "hybrid", rerank }, { embeddings: provider });
      expect({ rerank, first: results[0]?.path }).toEqual({ rerank, first: SCOPE });
    }
    db.close();
  }, 120_000);

  test("an exact title counts the same way", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root, SCOPE);
    const plain = await hybridSearch(db, { query: "scope log", mode: "hybrid", rerank: "none" }, { embeddings: provider });
    const titled = plain.results.find((r) => r.path === DIARY);
    expect(titled?.title).toBe("Scope Log");
    const { results } = await hybridSearch(db, { query: "SCOPE LOG", mode: "hybrid", rerank: "none" }, { embeddings: provider });
    db.close();
    expect(results[0]?.path).toBe(DIARY);
  }, 120_000);
});

describe("aliases leave tags alone", () => {
  test("a tag is still searchable and filterable, and an alias word is no longer a tag", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect(await paths(root, "zenithal", "--mode", "fts")).toEqual([DIARY]);
    expect(await paths(root, "my scope", "--mode", "fts", "--tag", "zenithal")).toEqual([DIARY]);
    // An alias still finds its document, through its own column.
    expect((await paths(root, "lightbucket", "--mode", "fts"))[0]).toBe(SCOPE);

    const db = new Database(join(root, "brain.db"), { readonly: true });
    const row = db
      .prepare("SELECT fts.tags AS tags, fts.aliases AS aliases FROM documents_fts fts JOIN documents d ON d.id = fts.rowid WHERE d.path = ?")
      .get(SCOPE) as { tags: string; aliases: string };
    db.close();
    expect(row.tags).not.toContain("lightbucket");
    expect(row.aliases.split("\n")).toEqual(["my scope", "the Dobsonian", "the lightbucket"]);
  }, 120_000);
});

describe("schema 14", () => {
  test("an index from before it gets the aliases column on its next writable open, searchable at once", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const path = join(root, "brain.db");
    // Put back the four-column table a schema-13 index had, with its rows.
    const old = new Database(path);
    old.run("DROP TABLE documents_fts");
    old.run("CREATE VIRTUAL TABLE documents_fts USING fts5(title, summary, content, tags, tokenize='porter unicode61')");
    old.run("INSERT INTO documents_fts(rowid, title, summary, content, tags) SELECT id, title, COALESCE(summary, ''), content, '' FROM documents");
    old.run("UPDATE index_metadata SET value = '13' WHERE key = 'schema_version'");
    old.close();

    // Read-only, the old table is searched as it is.
    const readonly = openDatabase(path, { readonly: true });
    const before = await hybridSearch(readonly, { query: "zenithal log", mode: "fts", rerank: "none" });
    readonly.close();
    expect(before.warnings).toEqual([]);
    expect(before.results.map((r) => r.path)).toContain(DIARY);

    const db = openDatabase(path);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as { sql: string }).sql;
    const count = (db.prepare("SELECT COUNT(*) AS n FROM documents_fts").get() as { n: number }).n;
    const docs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    db.close();
    expect(sql).toContain("aliases");
    expect(count).toBe(docs);

    // The next index run writes each markdown row again, aliases included.
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect((await paths(root, "the Dobsonian", "--mode", "fts"))[0]).toBe(SCOPE);
    const after = new Database(path, { readonly: true });
    const aliases = (after.prepare("SELECT fts.aliases AS a FROM documents_fts fts JOIN documents d ON d.id = fts.rowid WHERE d.path = ?").get(SCOPE) as { a: string }).a;
    after.close();
    expect(aliases).toContain("the Dobsonian");
  }, 180_000);
});

describe("a search.language switch", () => {
  test("keeps the aliases column, and an alias still finds its document", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const config = join(root, "brain.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/\n\}\);\s*$/, '\n  search: { language: "none" },\n});\n'));
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);

    const db = new Database(join(root, "brain.db"), { readonly: true });
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as { sql: string }).sql;
    db.close();
    expect(sql).toContain("aliases");
    expect(sql).toContain("unicode61 remove_diacritics 2");
    expect((await paths(root, "lightbucket", "--mode", "fts"))[0]).toBe(SCOPE);
    expect((await paths(root, "my scope", "--mode", "fts"))[0]).toBe(SCOPE);
  }, 180_000);
});
