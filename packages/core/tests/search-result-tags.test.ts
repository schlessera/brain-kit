import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase, migrateVecSchema, setMeta } from "../src/lib/db.js";
import { filterSearch, hybridSearch } from "../src/lib/search-engine.js";
import { nameKey } from "../src/lib/name-key.js";
import type { EmbeddingProvider, RerankCandidate, Reranker } from "../src/lib/seams.js";
import { buildJevRequest } from "../src/providers/rerankers/jev.js";

let db: Database;
let embeddings: EmbeddingProvider;
let embeddingCalls: number;
beforeEach(async () => {
  db = openDatabase(":memory:");
  expect(await migrateVecSchema(db, 2)).toBe(true); // Actual sqlite-vec, no fallback lane.
  setMeta(db, "embedding_model", "test:nullable-tags");
  embeddingCalls = 0;
  embeddings = { id: "test:nullable-tags", dimensions: 2, embed: async () => [],
    embedQuery: async () => { embeddingCalls++; return new Float32Array([1, 0]); } };
  for (let id = 1; id <= 2; id++) {
    db.run("INSERT INTO documents(id,path,title,type,status,summary,created,updated,content,indexed_at) VALUES (?,?,?,'note','active',NULL,'2026-01-01','2026-01-01','topic','2026-01-01')", [id, `notes/${id}.md`, `Doc ${id}`]);
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,?,'','topic','')", [id, `Doc ${id}`]);
    const row = db.query("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,0,'','topic',1) RETURNING id").get(id) as { id: number };
    db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (?,?,0,'note')", [row.id, new Uint8Array(new Float32Array([1, (id - 1) * 0.2]).buffer)]);
  }
  db.run("INSERT INTO tags(id,name) VALUES (1,'voyage'),(2,'navigation')");
  db.run("INSERT INTO document_tags(document_id,tag_id) VALUES (2,1),(2,2)");
});
afterEach(() => db.close());

function assertTags(rows: Array<{ path: string; tags: unknown }>) {
  expect(rows).toHaveLength(2);
  expect(Object.fromEntries(rows.map(r => [r.path, r.tags]))).toEqual({ "notes/1.md": null, "notes/2.md": "voyage, navigation" });
}

describe("nullable tags from actual retrieval projections", () => {
  test("filter returns null/string controls with unchanged list metadata", () => {
    const rows = filterSearch(db, {});
    assertTags(rows);
    for (const row of rows) expect(row).toMatchObject({ summary: null, updated: "2026-01-01", score: 0, snippet: "" });
  });

  test.each(["fts", "vector", "hybrid"] as const)("%s preserves nullable tags and retrieval order", async (mode) => {
    const result = await hybridSearch(db, { query: "topic", mode, rerank: "none" }, { embeddings });
    expect(result.warnings).toEqual([]);
    assertTags(result.results);
    expect(result.results.map(r => r.path)).toEqual(["notes/1.md", "notes/2.md"]);
    expect(result.results.every(r => Number.isFinite(r.score) && r.score > 0)).toBe(true);
    expect(embeddingCalls).toBe(mode === "fts" ? 0 : 1);
  });

  test("exact-name fallback also preserves null/string when FTS found neither document", async () => {
    db.run("UPDATE documents SET title='Straße'");
    for (let id = 1; id <= 2; id++) db.run("INSERT INTO name_keys(key,document_id) VALUES (?,?)", [nameKey("Straße"), id]);
    expect(db.query("SELECT count(*) AS count FROM documents_fts WHERE documents_fts MATCH 'STRASSE'").get()).toEqual({ count: 0 });
    const result = await hybridSearch(db, { query: "STRASSE", mode: "fts", rerank: "none" });
    expect(result.warnings).toEqual([]);
    assertTags(result.results);
    expect(result.results.map(r => [r.path, r.score])).toEqual([["notes/1.md", 0], ["notes/2.md", 0]]);
  });

  test.each(["fts", "vector", "hybrid"] as const)("%s sends nonempty null/string candidates to the real injected seam", async (mode) => {
    const seen: RerankCandidate[][] = [];
    const reranker: Reranker = {
      id: "test:nullable-tags", capabilities: { modes: ["fts", "vector", "hybrid"], network: false },
      async rerank(req) {
        seen.push([...req.candidates]);
        return req.candidates.map((item, i) => ({ item, score: 1 / (i + 1) }));
      },
    };
    const result = await hybridSearch(db, { query: "topic", mode }, { embeddings, rerankerEnabled: true, reranker });
    expect(result.warnings).toEqual([]);
    assertTags(result.results);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(Object.fromEntries(seen[0].map(c => [c.id, c.tags]))).toEqual({ "notes/1.md": null, "notes/2.md": "voyage, navigation" });
    // Built-in request clipping remains text-only; widening the seam must not change it.
    const request = buildJevRequest("fixture-model", { query: "topic", candidates: seen[0] }).body;
    expect(request.state.candidates).toHaveLength(2);
    expect(request.state.candidates.map(c => c.tags)).toEqual(["", "voyage, navigation"]);
  });
});
