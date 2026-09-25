/**
 * `brain index --forget-cache <path>`: discard one document's generated text so
 * the next embeddings run generates it again.
 *
 * The sidecars only ever grow by appending, so a bad context or description
 * would otherwise stay forever: the file keeps its value, and the database
 * would append it straight back. Forgetting therefore clears both. The cache
 * lines go, the database rows return to the state generation starts from, and
 * the vectors built on the old text are dropped, because the embeddings phase
 * picks its work by "has no vector".
 */
import type { Database } from "bun:sqlite";

import { loadVecSupport, vecTableExists } from "../db.js";
import { placeholderFor } from "./assets.js";
import { chunkContextKey, forgetAssetEntries, forgetContextEntries } from "./caches.js";
import { acquireEmbeddingLock } from "./embedding-lock.js";
import { dropVectorsForDocuments } from "./vectors.js";

/**
 * Forget the cached contexts of a markdown document, or the cached
 * description of an asset. Returns the number of sidecar lines removed, or
 * `null` when nothing is indexed at `path`.
 *
 * An asset is forgotten by its bytes: every indexed asset with the same
 * content hash goes back to its placeholder, and every cache line for that
 * hash goes, whatever its title. Otherwise the description lookup would find
 * the bad text again under the twin's title.
 */
export async function forgetCachedEnrichment(
  db: Database,
  root: string,
  path: string
): Promise<number | null> {
  const doc = db
    .prepare("SELECT id, title, asset_type, content_hash FROM documents WHERE path = ?")
    .get(path) as { id: number; title: string; asset_type: string; content_hash: string | null } | null;
  if (!doc) return null;

  // A vector left behind would keep the chunk out of the next run's work, so
  // stored vectors must be droppable before anything is forgotten.
  const vec = await loadVecSupport(db);
  if (!vec.ok && vecTableExists(db)) {
    throw new Error(`Cannot drop stored vectors: sqlite-vec did not load (${vec.detail ?? vec.reason})`);
  }
  const hasVectors = vec.ok;

  // An embeddings run in flight would write the old text back to the database.
  const release = acquireEmbeddingLock(db);
  try {
    if (doc.asset_type === "markdown") return forgetDocument(db, root, doc, hasVectors);
    return forgetAsset(db, root, doc.content_hash, hasVectors);
  } finally {
    release();
  }
}

function forgetDocument(
  db: Database,
  root: string,
  doc: { id: number; title: string },
  hasVectors: boolean
): number {
  const chunks = db
    .prepare("SELECT heading, content FROM chunks WHERE document_id = ?")
    .all(doc.id) as { heading: string; content: string }[];
  const keys = new Set(chunks.map((c) => chunkContextKey(doc.title, c.heading, c.content)));
  // A context key carries no path: another document with the same title and
  // chunk text shares it, and its stored context would be appended straight
  // back. Every chunk under a forgotten key is reset, not only this document's.
  const sharing = db.prepare(
    `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.asset_type = 'markdown' AND d.title = ? AND c.heading = ? AND c.content = ?`
  );
  const clearContext = db.prepare("UPDATE chunks SET context = NULL WHERE id = ?");
  const dropVector = hasVectors ? db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
  db.transaction(() => {
    for (const chunk of chunks) {
      for (const { id } of sharing.all(doc.title, chunk.heading, chunk.content) as { id: number }[]) {
        clearContext.run(id);
        dropVector?.run(id);
      }
    }
  }).immediate();
  return forgetContextEntries(root, keys);
}

function forgetAsset(
  db: Database,
  root: string,
  contentHash: string | null,
  hasVectors: boolean
): number {
  if (!contentHash) return 0;
  const twins = db
    .prepare(
      `SELECT id, path, title, asset_type FROM documents
       WHERE asset_type != 'markdown' AND content_hash = ?`
    )
    .all(contentHash) as { id: number; path: string; title: string; asset_type: string }[];
  const updateDoc = db.prepare("UPDATE documents SET content = ? WHERE id = ?");
  const updateChunk = db.prepare(
    "UPDATE chunks SET content = ? WHERE document_id = ? AND chunk_index = 0"
  );
  const deleteFts = db.prepare("DELETE FROM documents_fts WHERE rowid = ?");
  const insertFts = db.prepare(
    "INSERT INTO documents_fts(rowid, title, summary, content, tags) VALUES (?, ?, '', ?, '')"
  );
  db.transaction(() => {
    for (const twin of twins) {
      const placeholder = placeholderFor({ path: twin.path, mimeType: twin.asset_type });
      updateDoc.run(placeholder, twin.id);
      updateChunk.run(placeholder, twin.id);
      deleteFts.run(twin.id);
      insertFts.run(twin.id, twin.title, placeholder);
    }
    if (hasVectors) dropVectorsForDocuments(db, twins.map((t) => t.id));
  }).immediate();
  return forgetAssetEntries(root, contentHash);
}
