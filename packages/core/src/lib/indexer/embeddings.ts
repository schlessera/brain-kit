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
import { loadContextCache } from "./caches.js";
import { generateChunkContexts, type EmbeddableChunk } from "./contexts.js";
import type { AssetEmbedTask, IndexRun } from "./types.js";
import { createVectorWriter, dropVectorsForDocuments, prepareVectorStore } from "./vectors.js";

/** Texts per provider call. */
const BATCH_SIZE = 50;
/** Provider calls in flight at once, for text and for assets respectively. */
const CONCURRENCY = 5;
const ASSET_CONCURRENCY = 10;

/** One page of missing chunks; the parent body is fetched once per document later. */
function chunksNeedingVectors(run: IndexRun, after: number, through: number): EmbeddableChunk[] {
  return run.db.prepare(
    `SELECT c.id, c.document_id, c.heading, c.content, c.context, d.title, d.summary
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.asset_type = 'markdown' AND c.id > ? AND c.id <= ?
       AND NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.chunk_id = c.id)
     ORDER BY c.id LIMIT ?`
  ).all(after, through, BATCH_SIZE * CONCURRENCY) as EmbeddableChunk[];
}

/** Generate contexts and vectors for one bounded page at a time. */
async function embedMarkdownChunks(
  run: IndexRun,
  provider: EmbeddingProvider,
  docIdsNeedingEmbedding: number[]
): Promise<void> {
  dropVectorsForDocuments(run.db, docIdsNeedingEmbedding);
  const writeVectors = createVectorWriter(run, provider);
  // A finite high-water mark prevents an active editor from extending this run
  // forever. Failed chunks are passed by the cursor and retried NEXT run.
  const { last } = run.db.query("SELECT COALESCE(MAX(id), 0) AS last FROM chunks").get() as { last: number };
  let after = 0;
  let skipped = 0;
  let cache: Map<string, string> | undefined;
  while (after < last) {
    const chunks = chunksNeedingVectors(run, after, last);
    if (chunks.length === 0) break;
    after = chunks[chunks.length - 1].id;
    cache ??= loadContextCache(run.root);
    const failedContext = await generateChunkContexts(run, chunks, cache);
    const embeddable = chunks.filter((c) => !failedContext.has(c.id));
    const batches: Array<{ texts: string[]; chunks: EmbeddableChunk[] }> = [];
    for (let i = 0; i < embeddable.length; i += BATCH_SIZE) {
      const slice = embeddable.slice(i, i + BATCH_SIZE);
      batches.push({
        texts: slice.map((c) => chunkTextForEmbedding(c.title, c.heading, c.content, c.context)),
        chunks: slice,
      });
    }
    const results = await Promise.allSettled(batches.map((b) => provider.embed(b.texts)));
    for (let b = 0; b < results.length; b++) {
      const result = results[b];
      if (result.status === "rejected") {
        skipped++;
        run.warn(`  SKIP embed batch: ${(result.reason as Error)?.message ?? result.reason}`);
        continue;
      }
      const batchChunks = batches[b].chunks;
      if (result.value.length !== batchChunks.length) {
        skipped++;
        run.warn("  SKIP embed batch: provider returned an incorrect vector count");
        continue;
      }
      run.stats.embeddings += writeVectors(result.value.map((embedding, j) => ({
        chunkId: batchChunks[j].id,
        content: batchChunks[j].content,
        embedding,
      })));
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

  const writeVectors = createVectorWriter(run, provider);
  const getChunkId = run.db.prepare(
    "SELECT id, content FROM chunks WHERE document_id = ? AND chunk_index = 0"
  );

  const tasks = queue
    .map((asset) => {
      const chunkRow = getChunkId.get(asset.docId) as { id: number; content: string } | null;
      return { ...asset, chunkId: chunkRow?.id ?? null, content: chunkRow?.content ?? "" };
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
        const written = writeVectors([{ chunkId: asset.chunkId, content: asset.content, embedding: result.value }]);
        run.stats.embeddings += written;
        if (written) run.report(`    Embedded: ${asset.path}`);
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
