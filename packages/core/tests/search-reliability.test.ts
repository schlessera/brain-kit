import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { initContext } from "../src/lib/context";
import { openDatabase, migrateVecSchema, setMeta } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { filterSearch, hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";

let db: Database;
let embedCalls: number;
let provider: EmbeddingProvider;
beforeEach(async () => {
  db = openDatabase(":memory:");
  expect(await migrateVecSchema(db, 2)).toBe(true);
  setMeta(db, "embedding_model", "test:search");
  embedCalls = 0;
  provider = {
    id: "test:search", dimensions: 2,
    embed: async () => [],
    embedQuery: async () => { embedCalls++; return new Float32Array([1, 0]); },
  };
});
afterEach(() => db.close());

function addDoc(id: number, chunks: number, distance: number, opts: { tagged?: boolean; status?: string; type?: string; updated?: string; deadline?: string } = {}) {
  const status = opts.status ?? "active";
  const type = opts.type ?? "note";
  const updated = opts.updated ?? "2026-01-01";
  db.run("INSERT INTO documents(id,path,title,type,status,created,updated,deadline,content,indexed_at) VALUES (?,?,?,?,?,'2026-01-01',?,?,'topic','2026-01-01')", [id, `notes/${id}.md`, `Doc ${id}`, type, status, updated, opts.deadline ?? null]);
  db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,'','','topic','')", [id]);
  if (opts.tagged) {
    db.run("INSERT OR IGNORE INTO tags(id,name) VALUES (1,'wanted')");
    db.run("INSERT INTO document_tags(document_id,tag_id) VALUES (?,1)", [id]);
  }
  for (let i = 0; i < chunks; i++) {
    const row = db.prepare("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,?,'','topic',1) RETURNING id").get(id, i) as { id: number };
    db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,?,?)", [row.id, new Uint8Array(new Float32Array([1, distance]).buffer), status === "archived" ? 1 : 0, type]);
  }
}

test("widens duplicate-heavy KNN results to fill the document limit with one embedding", async () => {
  addDoc(1, 6, 0);
  addDoc(2, 1, 0.2);
  addDoc(3, 1, 0.3);
  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 2 }, { embeddings: provider });
  expect(result.results.map(r => r.path)).toEqual(["notes/1.md", "notes/2.md"]);
  expect(result.warnings).toEqual([]);
  expect(embedCalls).toBe(1);
});

test("widens after tag filtering and still excludes archived and other-type documents", async () => {
  addDoc(1, 20, 0);
  addDoc(2, 1, 0.2, { tagged: true });
  addDoc(3, 1, 0.3, { tagged: true });
  addDoc(4, 50, 0, { tagged: true, status: "archived" });
  addDoc(5, 50, 0, { tagged: true, type: "project" });
  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 2, tag: "wanted", type: "note" }, { embeddings: provider });
  expect(result.results.map(r => r.path)).toEqual(["notes/2.md", "notes/3.md"]);
  expect(embedCalls).toBe(1);
});

test("a post-KNN date filter widens the window to fill the limit", async () => {
  // Doc 1 owns the nearest chunks but is too old; the two recent docs sit
  // beyond the first KNN window.
  addDoc(1, 20, 0, { updated: "2026-01-01" });
  addDoc(2, 1, 0.2, { updated: "2026-03-01" });
  addDoc(3, 1, 0.3, { updated: "2026-03-02" });
  const ks: number[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("FROM vec_chunks WHERE embedding MATCH")) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...args: Parameters<typeof all>) => { ks.push(args[1] as number); return all(...args); }) as typeof statement.all;
    return statement;
  }) as typeof db.prepare;

  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 2, updatedSince: "2026-03-01" }, { embeddings: provider });
  expect(result.results.map(r => r.path)).toEqual(["notes/2.md", "notes/3.md"]);
  expect(embedCalls).toBe(1);
  // A date filter is a post-filter: the first window is limit x 10, not x 3.
  expect(ks[0]).toBe(20);
});

test("a vector-lane date sort chooses the limit by date, beyond the nearest document's chunks", async () => {
  // Doc 1 owns the nearest chunks and the latest deadline; doc 3 is farthest
  // and due first.
  addDoc(1, 10, 0, { deadline: "2026-12-31" });
  addDoc(2, 1, 0.2, { deadline: "2026-06-01" });
  addDoc(3, 1, 0.3, { deadline: "2026-03-01" });
  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 1, sort: "deadline" }, { embeddings: provider });
  expect(result.results.map(r => r.path)).toEqual(["notes/3.md"]);
});

test("a full-text date sort considers exactly the best max(limit x 20, 500) documents", async () => {
  // 520 matches. The two weakest (longest documents) carry the two earliest
  // deadlines: rank 501 is outside the documented pool, rank 500 inside it.
  const insert = (id: number, content: string, deadline: string) => {
    db.run("INSERT INTO documents(id,path,title,type,status,created,updated,deadline,content,indexed_at) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01',?,?,'2026-01-01')", [id, `notes/${id}.md`, `Doc ${id}`, deadline, content]);
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,'','',?,'')", [id, content]);
  };
  for (let id = 1; id <= 498; id++) insert(id, "topic", "2026-12-31");
  insert(499, `topic ${"filler ".repeat(5)}`, "2026-12-31");
  insert(500, `topic ${"filler ".repeat(10)}`, "2026-02-01");
  insert(501, `topic ${"filler ".repeat(20)}`, "2026-01-01");
  for (let id = 502; id <= 520; id++) insert(id, `topic ${"filler ".repeat(40)}`, "2026-12-31");
  const ranked = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "none", limit: 520 });
  expect(ranked.results.findIndex(r => r.path === "notes/500.md")).toBe(499);
  expect(ranked.results.findIndex(r => r.path === "notes/501.md")).toBe(500);

  const result = await hybridSearch(db, { query: "topic", mode: "fts", rerank: "none", limit: 1, sort: "deadline" });
  expect(result.results.map(r => r.path)).toEqual(["notes/500.md"]);
});

test("stops at exhaustion when filters leave too few results", async () => {
  addDoc(1, 25, 0);
  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 2, tag: "wanted" }, { embeddings: provider });
  expect(result.results).toEqual([]);
  expect(embedCalls).toBe(1);
});

test("keeps the 500-chunk work cap on a pathological long document", async () => {
  addDoc(1, 501, 0);
  addDoc(2, 1, 0.2);
  const result = await hybridSearch(db, { query: "topic", mode: "vector", limit: 2 }, { embeddings: provider });
  expect(result.results.map(r => r.path)).toEqual(["notes/1.md"]);
  expect(embedCalls).toBe(1);
});

test("a stalled embedder yields FTS results and receives cancellation", async () => {
  addDoc(1, 1, 0);
  let signal: AbortSignal | undefined;
  provider.embedQuery = async (_query, opts) => {
    signal = opts?.signal;
    return new Promise(() => {});
  };
  const result = await hybridSearch(db, { query: "topic", mode: "hybrid" }, { embeddings: provider, queryTimeoutMs: 20 });
  expect(result.results.map(r => r.path)).toEqual(["notes/1.md"]);
  expect(result.warnings[0]).toContain("timed out");
  expect(result.warnings[0]).toContain("FTS-only");
  expect(signal?.aborted).toBe(true);
});

test("late embedding completion never accesses the database after timeout", async () => {
  addDoc(1, 1, 0);
  let finish!: (value: Float32Array) => void;
  provider.embedQuery = () => new Promise(resolve => { finish = resolve; });
  const result = await hybridSearch(db, { query: "topic", mode: "vector" }, { embeddings: provider, queryTimeoutMs: 20 });
  expect(result.results).toEqual([]);
  expect(result.warnings[0]).toContain("timed out");
  db.close();
  finish(new Float32Array([1, 0]));
  await new Promise(resolve => setTimeout(resolve, 10));
});

test("fast embeddings retain hybrid fusion and cancel the deadline timer", async () => {
  addDoc(1, 1, 0);
  let signal: AbortSignal | undefined;
  provider.embedQuery = async (_query, opts) => { signal = opts?.signal; return new Float32Array([1, 0]); };
  const result = await hybridSearch(db, { query: "topic", mode: "hybrid" }, { embeddings: provider, queryTimeoutMs: 20 });
  expect(result.results).toHaveLength(1);
  expect(result.warnings).toEqual([]);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(signal?.aborted).toBe(false);
});

test("a sliced embedding uses only its own bytes", async () => {
  addDoc(1, 1, 0);
  provider.embedQuery = async () => new Float32Array([9, 1, 0, 9]).subarray(1, 3);
  const result = await hybridSearch(db, { query: "topic", mode: "vector" }, { embeddings: provider });
  expect(result.results).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

function addDatedDoc(id: number, type: string, updated: string, content: string) {
  db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,?,'active',?,?,?,?)", [id, `notes/${id}.md`, `Doc ${id}`, type, updated, updated, content, updated]);
  db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,'','',?,'')", [id, content]);
}

test("recency reranking measures from the pinned now, not the wall clock", async () => {
  // notes/1.md wins on BM25 (a shorter document) but is older and a context
  // doc, which loses recency credit fast; notes/2.md is an identity doc,
  // which barely decays. Fresh, the base score decides; two years on,
  // notes/1.md sits at the recency floor and notes/2.md overtakes it.
  addDatedDoc(1, "context", "2026-07-11", "harbour ferry timetable");
  addDatedDoc(2, "identity", "2026-07-12", "harbour ferry timetable notes");
  const search = (now: string) =>
    hybridSearch(db, { query: "harbour", mode: "fts", rerank: "heuristic", now: new Date(now) });

  // Freeze the ambient clock on the first date, so a search that ignored
  // `now` would pass the first assertion and fail on the second.
  setSystemTime(new Date("2026-07-12"));
  try {
    const fresh = await search("2026-07-12");
    expect(fresh.results.map(r => r.path)).toEqual(["notes/1.md", "notes/2.md"]);
    const later = await search("2028-07-12");
    expect(later.results.map(r => r.path)).toEqual(["notes/2.md", "notes/1.md"]);
  } finally {
    setSystemTime();
  }
});

test("an invalid now is refused rather than scoring every result NaN", async () => {
  addDatedDoc(1, "context", "2026-07-11", "harbour");
  await expect(
    hybridSearch(db, { query: "harbour", mode: "fts", now: new Date("not-a-date") })
  ).rejects.toThrow("now must be a valid Date");
});

test("every lane returns the document's deadline", async () => {
  addDoc(1, 1, 0);
  addDoc(2, 1, 0.2);
  db.run("UPDATE documents SET deadline = '2026-02-01' WHERE id = 1");
  const lanes = [
    { query: "topic", mode: "fts" as const },
    { query: "topic", mode: "vector" as const },
    { type: "note" },
  ];
  for (const opts of lanes) {
    const { results } = await hybridSearch(db, opts, { embeddings: provider });
    // Both documents share an `updated` date, so the filter lane's order is not pinned.
    expect(results.map(r => [r.path, r.deadline]).sort()).toEqual([["notes/1.md", "2026-02-01"], ["notes/2.md", null]]);
  }
});

// ---------------------------------------------------------------------------
// The full-text lane over fixtures/corpus (#400)
// ---------------------------------------------------------------------------

describe("full-text lane over fixtures/corpus", () => {
  const CORE_ROOT = resolve(import.meta.dir, "..");
  let root: string;
  let corpus: Database;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "brain-fts-corpus-"));
    cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
    // The fixture's brain.config.ts imports @schlessera/brain.
    symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
    const ctx = await initContext({ root });
    corpus = openDatabase(ctx.dbPath);
    await indexAll(corpus, { root, taxonomy: ctx.taxonomy, quiet: true });
  });

  afterAll(() => {
    corpus?.close();
    rmSync(root, { recursive: true, force: true });
  });

  // rerank "none" keeps these about the lane, not the reranker's factors.
  const fts = (query: string) => hybridSearch(corpus, { query, mode: "fts", rerank: "none" }, {});

  // Documents a raw MATCH expression hits, bypassing the query builder.
  const rawMatch = (expr: string) =>
    (corpus.prepare("SELECT d.path FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid WHERE documents_fts MATCH ?")
      .all(expr) as { path: string }[]).map(r => r.path).sort();

  test("a question matches the document that holds its content words but not its question words", async () => {
    const status = "projects/active/bookshelf/status.md";
    // The premise: "when" is nowhere in the document, so an AND of every
    // word cannot match it.
    expect(readFileSync(join(root, status), "utf8")).not.toMatch(/\bwhen\b/i);
    expect(rawMatch('"when" "is" "the" "bookshelf" "deadline"')).toEqual([]);

    const { results, warnings } = await fts("when is the bookshelf deadline");
    expect(warnings).toEqual([]);
    expect(results.map(r => r.path)).toContain(status);
  });

  test("an exact multi-word keyword query still ranks the one document holding every word first", async () => {
    const status = "projects/active/bookshelf/status.md";
    expect(rawMatch('"carcass" "glue-up"')).toEqual([status]);

    const { results } = await fts("carcass glue-up");
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]!.path).toBe(status);
  });

  test("a query made only of stopwords keeps the AND of all its terms", async () => {
    const expected = rawMatch('"the" "who"');
    expect(expected.length).toBeGreaterThan(0);

    const { results, warnings } = await fts("the who");
    expect(results.map(r => r.path).sort()).toEqual(expected);
    expect(warnings).toEqual([]);

    // A token with no letter or digit is not a content word either.
    const punctuated = await fts("? the who");
    expect(punctuated.results.map(r => r.path).sort()).toEqual(expected);
  });

  test("a query that is one quoted phrase stays a phrase", async () => {
    const expected = rawMatch('"face frame"');
    // The phrase is narrower than its words, or this proves nothing.
    expect(rawMatch('"face" OR "frame"').length).toBeGreaterThan(expected.length);

    const { results } = await fts('"face frame"');
    expect(results.map(r => r.path).sort()).toEqual(expected);
  });

  test("a quoted phrase holding FTS5 doubled-quote escapes stays one phrase", async () => {
    const query = '"face ""frame"""';
    const expected = rawMatch(query);
    expect(expected.length).toBeGreaterThan(0);
    expect(rawMatch('"face" OR "frame"').length).toBeGreaterThan(expected.length);

    const { results, warnings } = await fts(query);
    expect(results.map(r => r.path).sort()).toEqual(expected);
    expect(warnings).toEqual([]);
  });

  test("a mixed query matches only what its content words match", async () => {
    const all = (query: string) => hybridSearch(corpus, { query, mode: "fts", rerank: "none", limit: 100 }, {});
    const expected = (await all("bookshelf deadline")).results.map(r => r.path).sort();
    // The stopwords alone reach documents the content words do not, or this
    // proves nothing.
    expect(rawMatch('"when" OR "is" OR "the"').filter(p => !expected.includes(p)).length).toBeGreaterThan(0);

    const { results } = await all("when is the bookshelf deadline");
    expect(results.map(r => r.path).sort()).toEqual(expected);
  });

  test("tokens carrying FTS5 syntax characters never raise a syntax error", async () => {
    for (const query of ['foo"bar', "deadline*", "a:b", "-bookshelf", "(bookshelf", "bookshelf)", "NEAR(bookshelf", "? the", '"unterminated bookshelf']) {
      const { warnings } = await fts(query);
      expect({ query, warnings }).toEqual({ query, warnings: [] });
    }
  });
});

test("an invalid date filter is refused rather than matching nothing", async () => {
  addDoc(1, 1, 0);
  await expect(
    hybridSearch(db, { query: "topic", mode: "fts", updatedSince: "2026-13-01" })
  ).rejects.toThrow("updatedSince must be a date written YYYY-MM-DD");
  expect(() => filterSearch(db, { deadlineTo: "soon" })).toThrow("deadlineTo must be a date written YYYY-MM-DD");
});

// ---------------------------------------------------------------------------
// Weighted fusion and the full-text pool guard (#404)
// ---------------------------------------------------------------------------

describe("hybrid fusion", () => {
  // One document per id: a single chunk at `distance` from the query vector
  // (rank order in the vector lane), and `text` as its full-text body.
  function addLaneDoc(id: number, name: string, distance: number, text: string) {
    db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,'note','active','2026-01-01','2026-01-01',?,'2026-01-01')", [id, `notes/${name}.md`, `Doc ${name}`, text]);
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,'','',?,'')", [id, text]);
    const row = db.prepare("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,0,'',?,1) RETURNING id").get(id, text) as { id: number };
    db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'note')", [row.id, new Uint8Array(new Float32Array([1, distance]).buffer)]);
  }
  const hybrid = (limit: number) =>
    hybridSearch(db, { query: "lantern", mode: "hybrid", rerank: "none", limit }, { embeddings: provider });
  const ftsOnly = (limit: number) =>
    hybridSearch(db, { query: "lantern", mode: "fts", rerank: "none", limit });
  const vectorOnly = (limit: number) =>
    hybridSearch(db, { query: "lantern", mode: "vector", limit }, { embeddings: provider });

  test("a thin full-text lane cannot outvote the vector lane's first place", async () => {
    // Vector order: x, v2, v3, v4, y, a, b. Full-text matches only a, b, y,
    // in that order: three candidates, below half of limit 10.
    addLaneDoc(1, "x", 0.0, "unrelated words");
    addLaneDoc(2, "v2", 0.1, "other words");
    addLaneDoc(3, "v3", 0.2, "more words");
    addLaneDoc(4, "v4", 0.3, "still other words");
    addLaneDoc(5, "y", 0.4, "a lantern in a long line of words that dilutes the match somewhat");
    addLaneDoc(6, "a", 0.5, "lantern lantern lantern");
    addLaneDoc(7, "b", 0.6, "lantern lantern");
    // The premise: the lanes rank as described.
    expect((await ftsOnly(10)).results.map(r => r.path)).toEqual(["notes/a.md", "notes/b.md", "notes/y.md"]);
    expect((await vectorOnly(10)).results.map(r => r.path).slice(0, 5)).toEqual(["notes/x.md", "notes/v2.md", "notes/v3.md", "notes/v4.md", "notes/y.md"]);

    const { results } = await hybrid(10);
    expect(results[0]!.path).toBe("notes/x.md");
  });

  test("with a full full-text pool, a document both lanes rank still wins", async () => {
    // Exactly five full-text matches for limit 10: at the guard, so the lane
    // keeps its full weight. z is FTS first and vector fifth; x is vector
    // first only. At the thin weight z would lose to x (0.05/61 + 1/65 <
    // 1/61), so this also pins where the guard starts.
    addLaneDoc(1, "x", 0.0, "unrelated words");
    addLaneDoc(2, "v2", 0.1, "other words");
    addLaneDoc(3, "v3", 0.2, "more words");
    addLaneDoc(4, "v4", 0.3, "still other words");
    addLaneDoc(5, "z", 0.4, "lantern lantern lantern lantern");
    addLaneDoc(6, "f3", 0.7, "lantern lantern lantern");
    addLaneDoc(7, "f4", 0.8, "lantern lantern");
    addLaneDoc(8, "f5", 0.9, "a lantern among words");
    addLaneDoc(9, "f6", 0.95, "one lantern in a much longer run of other words here");
    const fts = (await ftsOnly(10)).results.map(r => r.path);
    expect(fts).toHaveLength(5);
    expect(fts[0]).toBe("notes/z.md");
    expect((await vectorOnly(10)).results.map(r => r.path)[4]).toBe("notes/z.md");

    const { results } = await hybrid(10);
    expect(results[0]!.path).toBe("notes/z.md");
  });
});
