import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase, initVecSupport, setMeta } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import type { EmbeddingProvider } from "../src/lib/seams";

let db: Database;
let embedCalls: number;
let provider: EmbeddingProvider;
beforeEach(async () => {
  db = openDatabase(":memory:");
  expect(await initVecSupport(db, 2)).toBe(true);
  setMeta(db, "embedding_model", "test:search");
  embedCalls = 0;
  provider = {
    id: "test:search", dimensions: 2,
    embed: async () => [],
    embedQuery: async () => { embedCalls++; return new Float32Array([1, 0]); },
  };
});
afterEach(() => db.close());

function addDoc(id: number, chunks: number, distance: number, opts: { tagged?: boolean; status?: string; type?: string } = {}) {
  const status = opts.status ?? "active";
  const type = opts.type ?? "note";
  db.run("INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (?,?,?,?,?,'2026-01-01','2026-01-01','topic','2026-01-01')", [id, `notes/${id}.md`, `Doc ${id}`, type, status]);
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
