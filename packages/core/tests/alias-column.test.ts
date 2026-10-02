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
import { nameKeys } from "../src/lib/name-key";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { loadVec } from "./vec-fixture";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

const GUIDE = "studies/star-bearings.md"; // aliases: "my bearings", "the Calypso guide", "the bearingbook"
const DIARY = "notes/bearings-diary.md";

/** A log that says "bearings" in its title and "my bearings" over and over in its body, and carries a tag no text uses. */
const DIARY_TEXT = [
  "---",
  "type: note",
  "title: Bearings Log",
  'created: "2026-01-01"',
  'updated: "2026-01-02"',
  "tags: [zenithal]",
  "---",
  "",
  "Checked my bearings at dusk. My bearings needed another reading, so my bearings stayed open on the shore for an hour.",
  "Next time my bearings guide goes below the cave; my bearings are easier to read there.",
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
    .all(GUIDE, DIARY) as { id: number; path: string }[];
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
    const found = await paths(root, "my bearings", "--mode", "fts");
    expect(found).toContain(DIARY);
    expect(found[0]).toBe(GUIDE);
  }, 120_000);

  test("ranks its document first under hybrid, when the vector lane ranks another first", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root, DIARY);

    const vector = await hybridSearch(db, { query: "my bearings", mode: "vector", rerank: "none" }, { embeddings: provider });
    expect(vector.results[0]?.path).toBe(DIARY); // the premise
    for (const rerank of ["none", "heuristic"] as const) {
      const { results } = await hybridSearch(db, { query: "My  Bearings", mode: "hybrid", rerank }, { embeddings: provider });
      expect({ rerank, first: results[0]?.path }).toEqual({ rerank, first: GUIDE });
    }
    db.close();
  }, 120_000);

  test("an exact title counts the same way", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const { db, provider } = await withVectors(root, GUIDE);
    const plain = await hybridSearch(db, { query: "bearings log", mode: "hybrid", rerank: "none" }, { embeddings: provider });
    const titled = plain.results.find((r) => r.path === DIARY);
    expect(titled?.title).toBe("Bearings Log");
    const { results } = await hybridSearch(db, { query: "BEARINGS LOG", mode: "hybrid", rerank: "none" }, { embeddings: provider });
    db.close();
    expect(results[0]?.path).toBe(DIARY);
  }, 120_000);
});

describe("aliases leave tags alone", () => {
  test("a tag is still searchable and filterable, and an alias word is no longer a tag", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect(await paths(root, "zenithal", "--mode", "fts")).toEqual([DIARY]);
    expect(await paths(root, "my bearings", "--mode", "fts", "--tag", "zenithal")).toEqual([DIARY]);
    // An alias still finds its document, through its own column.
    expect((await paths(root, "bearingbook", "--mode", "fts"))[0]).toBe(GUIDE);

    const db = new Database(join(root, "brain.db"), { readonly: true });
    const row = db
      .prepare("SELECT fts.tags AS tags, fts.aliases AS aliases FROM documents_fts fts JOIN documents d ON d.id = fts.rowid WHERE d.path = ?")
      .get(GUIDE) as { tags: string; aliases: string };
    db.close();
    expect(row.tags).not.toContain("bearingbook");
    expect(row.aliases.split("\n")).toEqual(["my bearings", "the Calypso guide", "the bearingbook"]);
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
    expect((await paths(root, "the Calypso guide", "--mode", "fts"))[0]).toBe(GUIDE);
    const after = new Database(path, { readonly: true });
    const aliases = (after.prepare("SELECT fts.aliases AS a FROM documents_fts fts JOIN documents d ON d.id = fts.rowid WHERE d.path = ?").get(GUIDE) as { a: string }).a;
    after.close();
    expect(aliases).toContain("the Calypso guide");
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
    expect((await paths(root, "bearingbook", "--mode", "fts"))[0]).toBe(GUIDE);
    expect((await paths(root, "my bearings", "--mode", "fts"))[0]).toBe(GUIDE);
  }, 180_000);
});

/** A hand-built index (schema 14): title, aliases and body per document, its body one chunk. */
function handBuilt() {
  const db = openDatabase(":memory:");
  let id = 0;
  const add = (
    path: string,
    title: string,
    body: string,
    meta: { aliases?: string[]; relevance?: string; status?: string; updated?: string } = {}
  ) => {
    const docId = ++id;
    db.run(
      "INSERT INTO documents(id,path,title,type,status,relevance,created,updated,content,indexed_at) VALUES (?,?,?,'note',?,?,'2026-01-01',?,?,'2026-01-01')",
      [docId, path, title, meta.status ?? "active", meta.relevance ?? "primary", meta.updated ?? "2026-06-01", body]
    );
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags,aliases) VALUES (?,?,'',?,'',?)", [docId, title, body, (meta.aliases ?? []).join("\n")]);
    db.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,0,'',?,1)", [docId, body]);
    // As the indexer writes them.
    for (const key of nameKeys(title, meta.aliases ?? [])) db.run("INSERT INTO name_keys(key, document_id) VALUES (?, ?)", [key, docId]);
    return docId;
  };
  /** `newer` supersedes `older`, as the indexer resolves it. */
  const supersede = (newer: number, older: number) =>
    db.run("INSERT INTO supersedes(source_id, target, target_id) VALUES (?, 'x', ?)", [newer, older]);
  return { db, add, supersede };
}

describe("an exact name is found whatever the lanes retrieved", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `gravel${i}`).join(" ");

  test("when the full-text pool is taken by better-scoring documents, supersededBy included", async () => {
    const { db, add, supersede } = handBuilt();
    const setup = add("studies/setup.md", "Star Guide setup", words(2000), { aliases: ["my bearings"] });
    const newer = add("studies/setup-v2.md", "Star Guide setup, revised", words(10));
    supersede(newer, setup);
    for (let i = 0; i < 42; i++) add(`notes/bearings-${i}.md`, "Bearings notes", "bearings bearings");
    for (const limit of [1, 20]) {
      const { results } = await hybridSearch(db, { query: "my bearings", mode: "fts", rerank: "none", limit });
      expect({ limit, first: results[0]?.path, by: results[0]?.supersededBy, count: results.length }).toEqual({
        limit,
        first: "studies/setup.md",
        by: "studies/setup-v2.md",
        count: limit,
      });
    }
    db.close();
  });

  test("when the tokenizer does not match the folded form, supersededBy included", async () => {
    const { db, add, supersede } = handBuilt();
    const street = add("notes/street.md", "Street names", "Notes on the corner.", { aliases: ["Straße"] });
    supersede(add("notes/street-v2.md", "Street names, revised", "Corner notes."), street);
    add("notes/other.md", "Other", "strasse strasse");
    const { results } = await hybridSearch(db, { query: "STRASSE", mode: "fts", rerank: "none" });
    expect({ first: results[0]?.path, by: results[0]?.supersededBy }).toEqual({ first: "notes/street.md", by: "notes/street-v2.md" });
    db.close();
  });

  test("through the name index, never a scan of every document", async () => {
    const { db, add } = handBuilt();
    for (let i = 0; i < 20; i++) add(`notes/n${i}.md`, `Note ${i}`, "text");
    const lookups: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("FROM name_keys")) lookups.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    await hybridSearch(db, { query: "nothing named this", mode: "fts", rerank: "none" });
    db.prepare = prepare;
    expect(lookups).toHaveLength(1);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${lookups[0]}`).all("nothing named this", "archived") as { detail: string }[]).map((r) => r.detail);
    expect(plan.some((d) => /SEARCH k USING (PRIMARY KEY|INDEX)/.test(d))).toBe(true);
    expect(plan.filter((d) => d.startsWith("SCAN "))).toEqual([]);
    db.close();
  });

  test("but not past the search's filters", async () => {
    const { db, add } = handBuilt();
    add("notes/old.md", "Old setup", words(20), { aliases: ["my bearings"], status: "archived" });
    add("notes/bearings.md", "Bearings notes", "bearings bearings");
    const { results } = await hybridSearch(db, { query: "my bearings", mode: "fts", rerank: "none" });
    expect(results.map((r) => r.path)).toEqual(["notes/bearings.md"]);
    db.close();
  });

  test("and it goes first after the rerank, which favours the other document", async () => {
    const { db, add } = handBuilt();
    // Everything the reranker weighs against the named document.
    add("studies/setup.md", "Star Guide setup", `my bearings ${words(40)}`, {
      aliases: ["my bearings"],
      relevance: "historical",
      status: "draft",
      updated: "2000-01-01",
    });
    add("notes/bearings.md", "Bearings notes", "my bearings my bearings my bearings", { updated: "2026-06-30" });
    const now = new Date("2026-07-01T00:00:00Z");
    // The premise: ranked on its own, the reranked order puts the other first.
    const plain = await hybridSearch(db, { query: "bearings my", mode: "fts", now });
    expect(plain.results[0]?.path).toBe("notes/bearings.md");
    const { results } = await hybridSearch(db, { query: "my bearings", mode: "fts", now });
    expect(results[0]?.path).toBe("studies/setup.md");
    db.close();
  });
});
