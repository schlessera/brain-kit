/**
 * Full-text search over chunks (#402): a long document's match is found in
 * the section it sits in, and the chunk table follows every write to chunks.
 *
 * The extra documents go into a temp copy of the corpus, so the fixture's
 * pinned counts stay put.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";

import { openDatabase, SCHEMA_VERSION } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

const doc = (title: string, body: string, summary?: string) =>
  [
    "---",
    "type: note",
    `title: ${title}`,
    ...(summary ? [`summary: ${summary}`] : []),
    'created: "2026-01-01"',
    'updated: "2026-01-02"',
    "---",
    "",
    body,
    "",
  ].join("\n");

/** A long field manual with one section on mirror recoating, among many that are not. */
const LONG = doc(
  "Field Manual",
  Array.from({ length: 30 }, (_, i) =>
    i === 17
      ? "## Recoating\n\nSend the primary mirror for recoating when the aluminium turns milky: a recoated mirror " +
        "reflects again, and recoating every decade keeps the mirror bright. Pack the mirror face up in foam, " +
        "label the crate with the focal length, and ask the optician for a protective overcoat on the new " +
        "aluminium, which roughly doubles how long the coating lasts before it needs doing again. While the " +
        "mirror is away, cap the tube, check the spider vanes for play, and clean the secondary with distilled " +
        "water only; when the mirror comes back, collimate before the first night out."
      : `## Section ${i}\n\n${`Routine field note ${i} about trail walking, weather, water and camp chores. `.repeat(12)}`
  ).join("\n\n"),
  // The summary matches too, so both the document row and a chunk match, and
  // the snippet must still come from the chunk.
  "Trail and telescope upkeep, mirror care included"
);

/** A short note that mentions recoating once, among other words. */
const SHORT = doc("Workshop Visit", "Talked with the optician about mirror recoating costs and the queue for the spring.");

function brain(): string {
  const root = makeTempBrain();
  roots.push(root);
  writeFileSync(join(root, "notes/field-manual.md"), LONG);
  writeFileSync(join(root, "notes/workshop-visit.md"), SHORT);
  return root;
}

async function fts(root: string, query: string): Promise<Array<{ path: string; snippet: string }>> {
  const r = await runCli(root, ["search", query, "--mode", "fts", "--limit", "20", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout).results;
}

/** FTS5's own check that the chunk index matches the `chunks` rows; throws when it does not. */
function integrity(root: string): void {
  const db = new Database(join(root, "brain.db"));
  try {
    db.run("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)");
  } finally {
    db.close();
  }
}

describe("the chunk full-text table follows chunks", () => {
  test("a chunk updated in place is re-indexed", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (1,'a.md','A','note','active','2026-01-01','2026-01-01','x','2026-01-01')");
    db.run("INSERT INTO chunks(id,document_id,chunk_index,heading,content,token_estimate) VALUES (1,1,0,'','an old placeholder',1)");
    db.run("UPDATE chunks SET content = 'a new description' WHERE id = 1");
    const count = (word: string) => (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(word) as { n: number }).n;
    expect({ placeholder: count("placeholder"), description: count("description") }).toEqual({ placeholder: 0, description: 1 });
    db.run("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)");
    db.close();
  });
});

describe("a document found only across its sections", () => {
  test("is still found, and ranks after every document found in one place, reranked or not", async () => {
    const db = openDatabase(":memory:");
    const add = (id: number, path: string, chunks: string[]) => {
      db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01',?,'2026-01-01')", [id, path, path, chunks.join("\n\n")]);
      db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,'','',?,'')", [id, chunks.join("\n\n")]);
      chunks.forEach((text, i) => db.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,?,'',?,1)", [id, i, text]));
    };
    // "the who" is stopwords only, so it is an AND: one-place needs both words in one chunk.
    add(1, "notes/one-place.md", [`the band called the who played ${"loud and long into the night ".repeat(20)}`]);
    add(2, "notes/split.md", ["the", "who"]);
    for (const rerank of ["none", undefined] as const) {
      const { results } = await hybridSearch(db, { query: "the who", mode: "fts", ...(rerank ? { rerank } : {}) });
      expect({ rerank, paths: results.map((r) => r.path) }).toEqual({ rerank, paths: ["notes/one-place.md", "notes/split.md"] });
    }
    db.close();
  });
});

describe("full-text search over chunks", () => {
  test("a long document's matching section outranks a short note's passing mention, and gives the snippet", async () => {
    const root = brain();
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const results = await fts(root, "recoating mirror");
    const paths = results.map((r) => r.path);
    expect(paths.indexOf("notes/field-manual.md")).toBe(0);
    expect(paths).toContain("notes/workshop-visit.md");
    const snippet = results[0]!.snippet;
    expect(snippet).toContain(">>>recoating<<<");
    expect(snippet).not.toContain("Routine field note");
  }, 120_000);

  test("an edit re-indexes the chunk rows: an old section's words stop matching", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect((await fts(root, "aluminium")).map((r) => r.path)).toContain("notes/field-manual.md");

    writeFileSync(join(root, "notes/field-manual.md"), LONG.replaceAll("aluminium", "coating"));
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    expect((await fts(root, "aluminium")).map((r) => r.path)).not.toContain("notes/field-manual.md");
    integrity(root);
  }, 120_000);

  test("deleting a document removes its chunk rows from the index", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    rmSync(join(root, "notes/field-manual.md"));
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    integrity(root);
    expect((await fts(root, "aluminium")).map((r) => r.path)).toEqual([]);
  }, 120_000);

  test("brain index --force rebuilds the chunk index from the markdown", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    integrity(root);
    expect((await fts(root, "aluminium")).map((r) => r.path)).toEqual(["notes/field-manual.md"]);
  }, 120_000);

  test("an index from before schema 13 gains the chunk index on its next writable open, without a reindex", async () => {
    const root = brain();
    await runCli(root, ["index", "--json"]);
    const path = join(root, "brain.db");
    const old = new Database(path);
    for (const trigger of ["chunks_fts_insert", "chunks_fts_delete", "chunks_fts_update"]) old.run(`DROP TRIGGER ${trigger}`);
    old.run("DROP TABLE chunks_fts");
    old.run("UPDATE index_metadata SET value = '12' WHERE key = 'schema_version'");
    old.close();

    // Read-only, it is searched as before: whole documents.
    const readonly = openDatabase(path, { readonly: true });
    const before = await hybridSearch(readonly, { query: "aluminium", mode: "fts", rerank: "none" });
    readonly.close();
    expect(before.results.map((r) => r.path)).toEqual(["notes/field-manual.md"]);
    expect(before.warnings).toEqual([]);

    const db = openDatabase(path);
    const version = db.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as { value: string };
    const rows = db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'aluminium'").get() as { n: number };
    db.close();
    expect(Number(version.value)).toBe(SCHEMA_VERSION);
    expect(rows.n).toBe(1);
    integrity(root);
  }, 120_000);
});
