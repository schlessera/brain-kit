/**
 * Images and PDFs: get them into the index, then describe them.
 *
 * Split in two because the halves have opposite costs. Identifying what
 * changed is synchronous, fast, and transactional; describing an asset is an
 * async call to a vision model that is slow, billable, and allowed to fail.
 * Keeping them apart is what lets a failed description leave a correct index
 * behind and retry next run instead of poisoning the row.
 *
 * The placeholder is the mechanism for that retry. Until a real description
 * lands, an asset's stored content is `[Image: path]` / `[PDF: path]`, which
 * keeps it findable by title and marks it as unfinished. Fallback text is
 * never persisted and the sidecar cache filters placeholders out, so a failed
 * vision call is always revisited rather than silently accepted.
 */
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { resolve } from "path";

import type { Asset, DocumentType } from "../types.js";
import { assetCacheKey, loadAssetCache } from "./caches.js";
import type { AssetEmbedTask, AssetTask, ExistingDoc, IndexRun } from "./types.js";

/** How many vision calls are in flight at once. */
const DESCRIBE_CONCURRENCY = 10;

/** The text an asset carries until a real description replaces it. */
function placeholderFor(asset: Pick<Asset, "path" | "mimeType">): string {
  const kind = asset.mimeType.startsWith("image/") ? "Image" : "PDF";
  return `[${kind}: ${asset.path}]`;
}

function prepareStatements(run: IndexRun) {
  const db = run.db;
  return {
    insertDoc: db.prepare(`INSERT OR REPLACE INTO documents
      (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, stat_fingerprint, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertChunk: db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate)
       VALUES (?, ?, ?, ?, ?)`
    ),
    updateChunkContent: db.prepare(
      "UPDATE chunks SET content = ? WHERE document_id = ? AND chunk_index = 0"
    ),
    updateDocContent: db.prepare("UPDATE documents SET content = ? WHERE id = ?"),
    insertFts: db.prepare(
      "INSERT INTO documents_fts(rowid, title, summary, content, tags) VALUES (?, ?, '', ?, '')"
    ),
    deleteFts: db.prepare("DELETE FROM documents_fts WHERE rowid = ?"),
    deleteChunks: db.prepare("DELETE FROM chunks WHERE document_id = ?"),
    getDocId: db.prepare("SELECT id FROM documents WHERE path = ?"),
    updateFingerprint: db.prepare("UPDATE documents SET stat_fingerprint = ? WHERE id = ?"),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/**
 * Insert or refresh the index rows for every asset whose bytes changed.
 *
 * The stat fingerprint (`mtimeMs-size`) is the fast path that makes this
 * affordable: without it every run re-read and re-hashed the entire asset
 * tree — hundreds of megabytes — only to conclude nothing had changed.
 */
function persistChangedAssets(
  run: IndexRun,
  st: Statements,
  assets: Asset[],
  existingDocs: Map<string, ExistingDoc>
): AssetTask[] {
  const changed: AssetTask[] = [];

  const write = run.db.transaction(() => {
    for (const asset of assets) {
      const fullPath = resolve(run.root, asset.path);
      const existing = existingDocs.get(asset.path);

      let fingerprint: string;
      try {
        const st_ = statSync(fullPath);
        fingerprint = `${st_.mtimeMs}-${st_.size}`;
      } catch {
        continue; // vanished mid-run — next run's deletion sweep handles it
      }
      if (!run.force && existing && existing.stat_fingerprint === fingerprint) continue;

      let raw: Buffer;
      try {
        raw = readFileSync(fullPath);
      } catch {
        continue;
      }
      const hash = createHash("sha256").update(raw).digest("hex");
      const isNew = !existing;
      const isChanged = !isNew && existing!.content_hash !== hash;

      if (!isNew && !isChanged) {
        // Same bytes, new mtime (a touch, a re-download): record the new
        // fingerprint so the fast path applies next run.
        st.updateFingerprint.run(fingerprint, existing!.id);
        continue;
      }

      const placeholder = placeholderFor(asset);

      if (isChanged && existing) {
        st.deleteChunks.run(existing.id);
        st.deleteFts.run(existing.id);
      }

      st.insertDoc.run(
        asset.path,
        asset.title,
        asset.type,
        "active",
        "primary",
        null,
        run.now,
        run.now,
        placeholder,
        hash,
        asset.mimeType,
        fingerprint,
        run.now
      );

      const docRow = st.getDocId.get(asset.path) as { id: number } | null;
      if (!docRow) continue;

      st.insertChunk.run(docRow.id, 0, asset.title, placeholder, 0);
      st.deleteFts.run(docRow.id);
      st.insertFts.run(docRow.id, asset.title, placeholder);
      run.stats.assets++;
      run.stats.chunks++;

      changed.push({ asset, raw: Buffer.from(raw), docId: docRow.id, hash });
    }
  });
  write.immediate();

  return changed;
}

/**
 * Queue assets still sitting on a placeholder — a previous run's vision call
 * failed, or ran with no enrichment configured. Their bytes are read lazily,
 * at describe time, since most runs will not have any.
 */
function queuePlaceholderRetries(
  run: IndexRun,
  queued: AssetTask[],
  assetsOnDisk: Set<string>
): AssetTask[] {
  const already = new Set(queued.map((t) => t.docId));
  const rows = run.db
    .prepare(
      `SELECT d.id AS docId, d.path, d.title, d.type AS docType,
              d.asset_type AS mimeType, d.content_hash AS hash
       FROM documents d
       WHERE d.asset_type != 'markdown'
         AND (d.content LIKE '[Image:%' OR d.content LIKE '[PDF:%')`
    )
    .all() as {
    docId: number;
    path: string;
    title: string;
    docType: string;
    mimeType: string;
    hash: string;
  }[];

  const retries: AssetTask[] = [];
  for (const row of rows) {
    if (already.has(row.docId) || !assetsOnDisk.has(row.path)) continue;
    retries.push({
      asset: {
        path: row.path,
        mimeType: row.mimeType,
        title: row.title,
        type: row.docType as DocumentType,
        sizeBytes: 0,
      },
      raw: null,
      docId: row.docId,
      hash: row.hash,
    });
  }
  return retries;
}

/**
 * Replace an asset's placeholder with its description, everywhere it appears,
 * and queue it for embedding.
 */
function makeFinisher(run: IndexRun, st: Statements, embedQueue: AssetEmbedTask[]) {
  const finish = (task: AssetTask, description: string) => {
    st.updateChunkContent.run(description, task.docId);
    st.updateDocContent.run(description, task.docId);
    st.deleteFts.run(task.docId);
    st.insertFts.run(task.docId, task.asset.title, description);
    embedQueue.push({
      docId: task.docId,
      path: task.asset.path,
      mimeType: task.asset.mimeType,
      description,
      docType: task.asset.type,
    });
  };
  return run.db.transaction((items: Array<[AssetTask, string]>) => {
    for (const [task, description] of items) finish(task, description);
  });
}

/**
 * Describe the queued assets, cache first, vision model second.
 *
 * A description that fails is left on its placeholder on purpose — see the
 * module header. Failures are reported, never thrown.
 */
async function describeAssets(
  run: IndexRun,
  st: Statements,
  tasks: AssetTask[],
  embedQueue: AssetEmbedTask[]
): Promise<void> {
  if (tasks.length === 0) return;

  const finishBatch = makeFinisher(run, st, embedQueue);
  const cache = loadAssetCache(run.root);
  const cacheHits: Array<[AssetTask, string]> = [];
  const needsDescription = tasks.filter((task) => {
    const cached = cache.get(assetCacheKey(task.hash, task.asset.title));
    if (cached === undefined) return true;
    cacheHits.push([task, cached]);
    return false;
  });

  if (cacheHits.length > 0) {
    finishBatch.immediate(cacheHits);
    run.report(`  Reused ${cacheHits.length} asset descriptions from cache`);
  }

  if (!run.enrichment) {
    if (needsDescription.length > 0) {
      run.report(
        `  ${needsDescription.length} asset(s) left undescribed — configure a completion provider to describe them`
      );
    }
    return;
  }

  const enrichment = run.enrichment;
  for (let i = 0; i < needsDescription.length; i += DESCRIBE_CONCURRENCY) {
    const batch = needsDescription.slice(i, i + DESCRIBE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async ({ asset, raw }) => {
        const buffer =
          raw ?? Buffer.from(await Bun.file(resolve(run.root, asset.path)).arrayBuffer());
        return enrichment.describeAsset(buffer, asset.mimeType, asset.title);
      })
    );

    const done: Array<[AssetTask, string]> = [];
    for (let j = 0; j < results.length; j++) {
      const task = batch[j];
      const result = results[j];
      if (result.status === "fulfilled") {
        done.push([task, result.value]);
        run.report(`  Described: ${task.asset.path}`);
      } else {
        run.warn(
          `  SKIP description: ${task.asset.path} — ${(result.reason as Error)?.message || result.reason}`
        );
      }
    }
    if (done.length > 0) finishBatch.immediate(done);
  }
}

/**
 * Run the whole asset phase and return what the embedding phase should embed.
 *
 * Only reached when the run wants embeddings: describing an asset is only
 * worth paying for if something is going to vectorize it.
 */
export async function indexAssets(
  run: IndexRun,
  assets: Asset[],
  existingDocs: Map<string, ExistingDoc>,
  assetsOnDisk: Set<string>
): Promise<AssetEmbedTask[]> {
  const embedQueue: AssetEmbedTask[] = [];
  if (assets.length > 0) {
    run.report(`Discovered ${assets.length} assets for multimodal indexing...`);
  }

  const st = prepareStatements(run);
  const tasks = persistChangedAssets(run, st, assets, existingDocs);
  tasks.push(...queuePlaceholderRetries(run, tasks, assetsOnDisk));

  await describeAssets(run, st, tasks, embedQueue);

  if (run.stats.assets > 0) run.report(`  Assets indexed: ${run.stats.assets}`);
  return embedQueue;
}

/**
 * Queue on-disk assets whose chunk has no vector but which this run did not
 * flag as changed — left behind by a run whose embed call hit a rate limit, or
 * that ran without a working provider. Reuses the description already stored
 * on the chunk, so nothing gets re-described (the expensive half).
 */
export function queueAssetsMissingVectors(
  run: IndexRun,
  queued: AssetEmbedTask[],
  assetsOnDisk: Set<string>
): AssetEmbedTask[] {
  const already = new Set(queued.map((a) => a.docId));
  const rows = run.db
    .prepare(
      `SELECT d.id AS docId, d.path AS path, d.asset_type AS mimeType, d.type AS docType,
              c.content AS description
       FROM documents d
       JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
       WHERE d.asset_type != 'markdown'
         AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
       ORDER BY d.id`
    )
    .all() as {
    docId: number;
    path: string;
    mimeType: string;
    docType: string;
    description: string;
  }[];

  const missing: AssetEmbedTask[] = [];
  for (const row of rows) {
    // Skip what is already queued, and stale rows whose file is gone.
    if (already.has(row.docId) || !assetsOnDisk.has(row.path)) continue;
    missing.push({
      docId: row.docId,
      path: row.path,
      mimeType: row.mimeType,
      docType: row.docType,
      description: row.description || row.path,
    });
  }
  return missing;
}
