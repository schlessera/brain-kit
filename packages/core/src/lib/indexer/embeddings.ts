/**
 * Turning chunks into vectors — the slow, billable, failure-tolerant end of
 * the pipeline.
 *
 * The governing idea is that embedding coverage is DECOUPLED from change
 * detection. Both passes here select their work by "has no vector" rather than
 * "changed this run", which makes every `--embeddings` run a backfill. That
 * closes a real hole: the no-embeddings post-commit hook updates
 * `content_hash`, so a later embeddings run would otherwise treat those
 * documents as unchanged and starve them of vectors forever.
 *
 * Failure is expected and never fatal. A batch whose retries are exhausted (a
 * daily quota, a rate limit) is skipped with a warning; its chunks have no
 * vector, so the next run picks them up by the same rule.
 */
import { resolve } from "path";

import { chunkTextForEmbedding } from "../chunker.js";
import { hasVecSupport } from "../db.js";
import type { EmbeddingProvider } from "../seams.js";
import { queueAssetsMissingVectors } from "./assets.js";
import { generateChunkContexts, type EmbeddableChunk } from "./contexts.js";
import type { AssetEmbedTask, IndexRun } from "./types.js";
import { dropVectorsForDocuments, prepareVectorStore } from "./vectors.js";

/** Texts per provider call. */
const BATCH_SIZE = 50;
/** Provider calls in flight at once, for text and for assets respectively. */
const CONCURRENCY = 5;
const ASSET_CONCURRENCY = 10;

/**
 * Every markdown chunk that lacks a vector.
 *
 * See the module header for why this is not "chunks of documents changed this
 * run" — the changed documents' vectors were just deleted by the caller, so
 * they qualify under this rule too.
 */
function chunksNeedingVectors(run: IndexRun): EmbeddableChunk[] {
  return run.db
    .prepare(
      `SELECT c.id, c.document_id, c.heading, c.content, c.context,
              d.title, d.summary, d.content AS doc_content,
              d.status AS doc_status, d.type AS doc_type
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.asset_type = 'markdown'
         AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
       ORDER BY c.id`
    )
    .all() as EmbeddableChunk[];
}

/** Generate contexts, then embed the chunks that got one. */
async function embedMarkdownChunks(
  run: IndexRun,
  provider: EmbeddingProvider,
  docIdsNeedingEmbedding: number[]
): Promise<void> {
  dropVectorsForDocuments(run.db, docIdsNeedingEmbedding);

  const chunks = chunksNeedingVectors(run);
  if (chunks.length === 0) return;

  const failedContext = await generateChunkContexts(run, chunks);
  const embeddable = chunks.filter((c) => !failedContext.has(c.id));
  if (embeddable.length === 0) return;

  const insertVec = run.db.prepare(
    "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, ?, ?)"
  );
  // One transaction per completed batch, rather than one autocommit per row.
  const insertBatch = run.db.transaction(
    (rows: Array<{ chunkId: number; embedding: Uint8Array; isArchived: number; docType: string }>) => {
      for (const row of rows) insertVec.run(row.chunkId, row.embedding, row.isArchived, row.docType);
    }
  );

  const batches: Array<{ texts: string[]; chunks: EmbeddableChunk[] }> = [];
  for (let i = 0; i < embeddable.length; i += BATCH_SIZE) {
    const slice = embeddable.slice(i, i + BATCH_SIZE);
    batches.push({
      texts: slice.map((c) => chunkTextForEmbedding(c.title, c.heading, c.content, c.context)),
      chunks: slice,
    });
  }

  let skipped = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrent = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(concurrent.map((b) => provider.embed(b.texts)));
    for (let b = 0; b < results.length; b++) {
      const result = results[b];
      if (result.status === "rejected") {
        skipped++;
        run.warn(`  SKIP embed batch: ${(result.reason as Error)?.message ?? result.reason}`);
        continue;
      }
      const batchChunks = concurrent[b].chunks;
      const rows = result.value.map((embedding, j) => ({
        chunkId: batchChunks[j].id,
        embedding: new Uint8Array(embedding.buffer),
        isArchived: batchChunks[j].doc_status === "archived" ? 1 : 0,
        docType: batchChunks[j].doc_type,
      }));
      insertBatch.immediate(rows);
      run.stats.embeddings += rows.length;
    }
  }

  run.report(`  Embedded ${run.stats.embeddings} text chunks`);
  if (skipped > 0) {
    run.warn(`  ${skipped} batch(es) skipped on errors — rerun with --embeddings to backfill`);
  }
}

/**
 * Embed assets from their bytes when the provider can, from their description
 * when it cannot — a provider without `embedImage`/`embedPdf` degrades to
 * embedding the text, which still beats no vector at all.
 */
async function embedAssets(
  run: IndexRun,
  provider: EmbeddingProvider,
  queue: AssetEmbedTask[]
): Promise<void> {
  if (queue.length === 0) return;
  run.report(`  Embedding ${queue.length} assets...`);

  dropVectorsForDocuments(
    run.db,
    queue.map((a) => a.docId)
  );

  const insertVec = run.db.prepare(
    "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, 0, ?)"
  );
  const getChunkId = run.db.prepare(
    "SELECT id FROM chunks WHERE document_id = ? AND chunk_index = 0"
  );

  const tasks = queue
    .map((asset) => {
      const chunkRow = getChunkId.get(asset.docId) as { id: number } | null;
      return { ...asset, chunkId: chunkRow?.id ?? null };
    })
    .filter((a): a is typeof a & { chunkId: number } => a.chunkId !== null);

  for (let i = 0; i < tasks.length; i += ASSET_CONCURRENCY) {
    const batch = tasks.slice(i, i + ASSET_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        const buffer = Buffer.from(
          await Bun.file(resolve(run.root, asset.path)).arrayBuffer()
        );
        if (asset.mimeType === "application/pdf") {
          return provider.embedPdf
            ? provider.embedPdf(buffer, asset.description)
            : (await provider.embed([asset.description]))[0];
        }
        return provider.embedImage
          ? provider.embedImage(buffer, asset.mimeType, asset.description)
          : (await provider.embed([asset.description]))[0];
      })
    );
    for (let j = 0; j < results.length; j++) {
      const asset = batch[j];
      const result = results[j];
      if (result.status === "fulfilled") {
        insertVec.run(asset.chunkId, new Uint8Array(result.value.buffer), asset.docType);
        run.stats.embeddings++;
        run.report(`    Embedded: ${asset.path}`);
      } else {
        run.warn(
          `    SKIP embedding: ${asset.path} — ${(result.reason as Error)?.message || result.reason}`
        );
      }
    }
  }
}

/**
 * The embedding phase. No-op unless the run asked for embeddings, a provider
 * was injected, and the vector store is usable.
 *
 * Returns whether the phase was ENTERED — not whether it embedded anything.
 * That distinction matters: a run that refuses to embed because the provider
 * changed has still produced asset descriptions, and those must be banked to
 * the sidecar caches or the next run pays for them again.
 */
export async function runEmbeddingPhase(
  run: IndexRun,
  docIdsNeedingEmbedding: number[],
  assetQueue: AssetEmbedTask[],
  assetsOnDisk: Set<string>
): Promise<boolean> {
  const provider = run.provider;
  if (!run.wantEmbeddings || !provider || !hasVecSupport(run.db)) return false;

  if (!(await prepareVectorStore(run, provider))) return true;

  run.report("Generating embeddings...");
  await embedMarkdownChunks(run, provider, docIdsNeedingEmbedding);

  assetQueue.push(...queueAssetsMissingVectors(run, assetQueue, assetsOnDisk));
  await embedAssets(run, provider, assetQueue);
  return true;
}
