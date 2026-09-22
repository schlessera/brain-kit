/**
 * The vector store's hygiene rules, kept apart from the code that fills it.
 *
 * The optional sqlite-vec table may not exist (no extension, older database).
 * Provider calls happen outside transactions; completed batches validate and
 * write together in a short immediate transaction.
 */
import type { Database } from "bun:sqlite";

import {
  embeddingIdentityMatches,
  getMeta,
  hasVecSupport,
  migrateVecSchema,
  setMeta,
} from "../db.js";
import type { EmbeddingProvider } from "../seams.js";
import type { IndexRun } from "./types.js";

/** Rows are deleted in batches of this many document ids per IN-list. */
const ID_BATCH = 500;

/** True when at least one vector is stored (cheap EXISTS probe). */
export function vecStoreHasRows(db: Database): boolean {
  try {
    const row = db.prepare("SELECT EXISTS(SELECT 1 FROM vec_chunks) AS n").get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  }
}

/**
 * Drop markdown vectors ahead of a `--force` rebuild.
 *
 * Asset vectors survive on purpose — see `wipeMarkdownState` in persist.ts for
 * the same rule on the relational side.
 */
export function dropMarkdownVectors(db: Database): void {
  if (!hasVecSupport(db)) return;
  try {
    db.run(`DELETE FROM vec_chunks WHERE chunk_id IN (
      SELECT c.id FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.asset_type = 'markdown')`);
  } catch {
    // vec_chunks may not exist yet
  }
}

/**
 * Delete vectors whose chunk is gone.
 *
 * Runs unconditionally rather than only when this run deleted something:
 * gating it on the current run left dead vectors behind whenever an EARLIER
 * run modified documents while sqlite-vec was unavailable, and dead chunk ids
 * quietly eat KNN candidate slots.
 */
export function dropOrphanedVectors(db: Database): void {
  if (!hasVecSupport(db)) return;
  try {
    db.run("DELETE FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)");
  } catch {
    // vec_chunks may not exist
  }
}

/** Delete every vector belonging to these documents, in bounded IN-lists. */
export function dropVectorsForDocuments(db: Database, docIds: number[]): void {
  for (let i = 0; i < docIds.length; i += ID_BATCH) {
    // Integer ids straight from the database — safe to interpolate.
    const ids = docIds.slice(i, i + ID_BATCH).join(",");
    if (!ids) continue;
    db.run(
      `DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${ids}))`
    );
  }
}

/**
 * Decide whether this run may write vectors, given who wrote the stored ones.
 *
 * Vectors carry the identity of the provider that produced them. If a
 * DIFFERENT provider now runs against a store that already holds vectors,
 * embedding into it would mix two vector spaces and rank garbage — so the run
 * refuses, leaves the stored vectors and their metadata untouched, and lets
 * `search-engine` report the mismatch and degrade to FTS. `--force` is the
 * explicit "yes, drop them and re-embed" (which re-runs paid calls).
 */
export async function prepareVectorStore(
  run: IndexRun,
  provider: EmbeddingProvider
): Promise<boolean> {
  const storedModel = getMeta(run.db, "embedding_model");
  const storedDims = getMeta(run.db, "embedding_dimensions");
  // Metadata describes the last provider, not necessarily the physical table:
  // --force can empty a markdown-only store before this phase is reached.
  const table = run.db.query("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'").get() as { sql: string } | null;
  const tableDims = table?.sql.match(/\bembedding\s+float\[(\d+)\]/i)?.[1];
  if (table && !tableDims) throw new Error("Cannot determine vec_chunks dimensions");
  const dimensionsChanged = tableDims !== String(provider.dimensions);
  const mismatch =
    vecStoreHasRows(run.db) &&
    (!embeddingIdentityMatches(storedModel, provider.id) ||
      storedDims !== String(provider.dimensions) || dimensionsChanged);

  if (mismatch && !run.force) {
    run.warn(
      `  Embedding provider changed: stored vectors were produced by ` +
        `'${storedModel}' (dim ${storedDims}) but the configured provider is ` +
        `'${provider.id}' (dim ${provider.dimensions}). Re-run ` +
        `'brain index --embeddings --force' to drop and re-embed them ` +
        `(this re-runs paid embedding calls). Skipping the embedding pass; ` +
        `vector search stays disabled until then.`
    );
    return false;
  }

  if (mismatch || dimensionsChanged) {
    run.report(
      `  Preparing vector table for '${provider.id}' (dim ${provider.dimensions})`
    );
    // Drop the TABLE, not just its rows: vec0 tables are fixed-width, so a
    // cross-dimension provider swap must recreate it at the new width.
    run.db.run("DROP TABLE IF EXISTS vec_chunks");
    if (!(await migrateVecSchema(run.db, provider.dimensions))) return false;
  }

  // Record the producing provider, so search-engine's mismatch check agrees
  // and a future run can detect a provider switch.
  setMeta(run.db, "embedding_model", provider.id);
  setMeta(run.db, "embedding_dimensions", String(provider.dimensions));
  return true;
}

/** Commit only results whose inputs and vector space still exist after await. */
export function createVectorWriter(run: IndexRun, provider: EmbeddingProvider) {
  const current = run.db.prepare(`
    SELECT c.content, d.status, d.type FROM chunks c
    JOIN documents d ON d.id = c.document_id WHERE c.id = ?`);
  const hasVector = run.db.prepare("SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?");
  const insert = run.db.prepare(
    "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, ?, ?)"
  );
  const write = run.db.transaction((rows: Array<{ chunkId: number; content: string; embedding: Float32Array }>) => {
    if (!embeddingIdentityMatches(getMeta(run.db, "embedding_model"), provider.id) ||
        getMeta(run.db, "embedding_dimensions") !== String(provider.dimensions)) {
      run.warn("  Skipping stale embedding results: vector provider changed during the request");
      return 0;
    }
    let written = 0;
    for (const row of rows) {
      const chunk = current.get(row.chunkId) as { content: string; status: string; type: string } | null;
      if (!chunk || chunk.content !== row.content || hasVector.get(row.chunkId)) continue;
      if (row.embedding.length !== provider.dimensions) throw new Error("Embedding provider returned incorrect vector dimensions");
      const bytes = new Uint8Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength);
      insert.run(row.chunkId, bytes, chunk.status === "archived" ? 1 : 0, chunk.type);
      written++;
    }
    return written;
  });
  return (rows: Parameters<typeof write>[0]) => write.immediate(rows);
}
