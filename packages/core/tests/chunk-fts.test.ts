/**
 * Full-text search over chunks (#402): a long document's match is found in
 * the section it sits in, and the chunk table follows every write to chunks.
 *
 * The extra documents go into a temp copy of the corpus, so the fixture's
 * pinned counts stay put.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { migrateVecSchema, openDatabase, SCHEMA_VERSION, setMeta } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";
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

/** How many chunks the chunk index finds for `word`: its postings, not the rows behind them. */
function postings(root: string, word: string): number {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(word) as { n: number }).n;
  } finally {
    db.close();
  }
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

/** A hand-built index: each document's chunks are written as given, and the triggers index them. */
function handBuilt() {
  const db = openDatabase(":memory:");
  let id = 0;
  const add = (
    path: string,
    chunks: string[],
    meta: { title?: string; relevance?: string; status?: string; updated?: string; generatedFrom?: string } = {}
  ) => {
    const docId = ++id;
    const body = chunks.join("\n\n");
    db.run(
      "INSERT INTO documents(id,path,title,type,status,relevance,created,updated,content,generated_from,indexed_at) VALUES (?,?,?,'note',?,?,'2026-01-01',?,?,?,'2026-01-01')",
      [docId, path, meta.title ?? path, meta.status ?? "active", meta.relevance ?? "primary", meta.updated ?? "2026-06-01", body, meta.generatedFrom ?? null]
    );
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,?,'',?,'')", [docId, meta.title ?? "", body]);
    chunks.forEach((text, i) => db.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,?,'',?,1)", [docId, i, text]));
  };
  return { db, add };
}

const filler = (n: number, word = "gravel") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

describe("the chunk lane picks each document's best chunk before the limit", () => {
  test("a document with one strong section is not pushed out by one with many", async () => {
    const { db, add } = handBuilt();
    add("notes/a.md", Array.from({ length: 50 }, () => "beacon ".repeat(100).trim()));
    add("notes/b.md", [`beacon light ${filler(70)}`, ...Array.from({ length: 100 }, (_, i) => filler(30, `ridge${i}x`))]);
    add("notes/c.md", [`beacon ${filler(100)}`]);
    const order = async (limit: number) =>
      (await hybridSearch(db, { query: "beacon", mode: "fts", rerank: "none", limit })).results.map((r) => r.path);
    expect(await order(20)).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]); // every document's best chunk, ranked
    expect(await order(2)).toEqual(["notes/a.md", "notes/b.md"]);
    db.close();
  });

  test("a document found by its title takes its snippet from its best matching chunk", async () => {
    const { db, add } = handBuilt();
    // Other documents own every strong chunk, so this one's weak chunk is not
    // among the chunk lane's best; it comes in on its title.
    for (const name of ["s1", "s2", "s3"]) add(`notes/${name}.md`, Array.from({ length: 10 }, () => `beacon beacon ${filler(20)}`));
    add("notes/x.md", [filler(40), `the beacon on the ridge ${filler(200)}`], { title: "Beacon" });
    const { results } = await hybridSearch(db, { query: "beacon", mode: "fts", rerank: "none", limit: 1 });
    db.close();
    expect(results[0]?.path).toBe("notes/x.md"); // the premise: its title match wins
    expect(results[0]?.snippet).toContain(">>>beacon<<< on the ridge");
  });
});

describe("a full-text search reads one snapshot", () => {
  test("a rebuild committing between its queries leaves the result whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-chunk-snapshot-"));
    roots.push(dir);
    const path = join(dir, "brain.db");
    const writer = openDatabase(path);
    writer.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (1,'notes/coast.md','Coast','note','active','2026-01-01','2026-06-01','x','2026-01-01')");
    writer.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (1,'Coast','','x','')");
    const TEXT = `the lighthouse keeper logs every beacon ${filler(30)}`;
    writer.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (1,0,'',?,1)", [TEXT]);

    const reader = openDatabase(path, { readonly: true });
    // Between the chunk lane's pick and the snippet lookup, another run
    // rewrites the document's chunks: same text, new ids, as --force does.
    const prepare = reader.prepare.bind(reader);
    let rebuilt = false;
    reader.prepare = ((sql: string) => {
      if (!rebuilt && sql.includes("snippet(chunks_fts")) {
        rebuilt = true;
        writer.run("DELETE FROM chunks WHERE document_id = 1");
        writer.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (1,0,'',?,1)", [TEXT]);
      }
      return prepare(sql);
    }) as typeof reader.prepare;

    const { results, warnings } = await hybridSearch(reader, { query: "beacon", mode: "fts", rerank: "none" });
    reader.close();
    writer.close();
    expect(rebuilt).toBe(true); // the premise: the rebuild did land mid-search
    expect(warnings).toEqual([]);
    expect(results.map((r) => ({ path: r.path, snippet: r.snippet }))).toEqual([
      { path: "notes/coast.md", snippet: expect.stringContaining(">>>beacon<<<") },
    ]);
  });
});

describe("a document found only across its sections, reranked", () => {
  test("stays after one found in one place, whatever their lifecycle factors", async () => {
    const { db, add } = handBuilt();
    // Everything the reranker weighs against it: historical, draft, generated, old.
    add("notes/one-place.md", [`the band called the who ${filler(60)}`], {
      relevance: "historical",
      status: "draft",
      updated: "2000-01-01",
      generatedFrom: "tools/export",
    });
    // Everything in its favour, but its two words sit in different chunks.
    add("notes/split.md", [`the ${filler(60)}`, `who ${filler(60)}`], { relevance: "primary", updated: "2026-06-30" });
    const now = new Date("2026-07-01T00:00:00Z");
    for (const rerank of ["none", "heuristic"] as const) {
      const { results } = await hybridSearch(db, { query: "the who", mode: "fts", rerank, now });
      expect({ rerank, paths: results.map((r) => r.path) }).toEqual({ rerank, paths: ["notes/one-place.md", "notes/split.md"] });
    }
    db.close();
  });

  /** The same two documents, for a hybrid search with a vector lane as `vectors` stages it. */
  async function lifecyclePair(vectors: "none" | "empty" | "one-place" | "split") {
    const { db, add } = handBuilt();
    add("notes/one-place.md", [`the band called the who ${filler(60)}`], {
      relevance: "historical",
      status: "draft",
      updated: "2000-01-01",
      generatedFrom: "tools/export",
    });
    add("notes/split.md", [`the ${filler(60)}`, `who ${filler(60)}`], { relevance: "primary", updated: "2026-06-30" });
    if (vectors !== "none") {
      expect(await migrateVecSchema(db, 2)).toBe(true);
      setMeta(db, "embedding_model", "test:tier");
      const near = vectors === "empty" ? null : vectors === "one-place" ? "notes/one-place.md" : "notes/split.md";
      if (near) {
        const chunk = db.prepare("SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? LIMIT 1").get(near) as { id: number };
        db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'note')", [chunk.id, new Uint8Array(new Float32Array([1, 0]).buffer)]);
      }
    }
    return db;
  }
  const provider = (fail = false): EmbeddingProvider => ({
    id: "test:tier",
    dimensions: 2,
    embed: async () => [],
    embedQuery: async () => {
      if (fail) throw new Error("embedding service down");
      return new Float32Array([1, 0]);
    },
  });
  const now = new Date("2026-07-01T00:00:00Z");
  const hybridOrder = async (db: Database, embeddings?: EmbeddingProvider) =>
    (await hybridSearch(db, { query: "the who", mode: "hybrid", now }, { embeddings })).results.map((r) => r.path);

  test("stays after it in hybrid degraded to full text: no extension, no provider, no vectors, a failed provider", async () => {
    const cases: Array<[string, () => Promise<{ db: Database; embeddings?: EmbeddingProvider }>]> = [
      ["no extension", async () => ({ db: await lifecyclePair("none"), embeddings: provider() })],
      ["no provider", async () => ({ db: await lifecyclePair("empty") })],
      ["no stored vectors", async () => ({ db: await lifecyclePair("empty"), embeddings: provider() })],
      ["a failed provider", async () => ({ db: await lifecyclePair("one-place"), embeddings: provider(true) })],
    ];
    for (const [name, make] of cases) {
      const { db, embeddings } = await make();
      expect({ name, paths: await hybridOrder(db, embeddings) }).toEqual({ name, paths: ["notes/one-place.md", "notes/split.md"] });
      db.close();
    }
  });

  test("with vector hits, the fused rank decides", async () => {
    const db = await lifecyclePair("split");
    // The vector lane finds only the split document; fused with the lifecycle
    // factors, it comes first, tier or not.
    expect(await hybridOrder(db, provider())).toEqual(["notes/split.md", "notes/one-place.md"]);
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
    // Lose the derived postings; the markdown and the chunk rows stay.
    const db = new Database(join(root, "brain.db"));
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES ('delete-all')");
    db.close();
    expect(postings(root, "aluminium")).toBe(0); // the precondition
    expect((await runCli(root, ["index", "--force", "--json"])).code).toBe(0);
    expect(postings(root, "aluminium")).toBe(1);
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
