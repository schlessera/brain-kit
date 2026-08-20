/**
 * `indexAll` — the pipeline, and nothing else.
 *
 * This file exists to be readable in one screen: the order of the phases IS
 * the design, and it used to be buried in a thousand-line function where the
 * only markers were comment banners. Each phase lives in its own module and
 * takes the shared `IndexRun`; what they hand each other is spelled out in
 * `types.ts`.
 *
 * The order is not arbitrary — every step below depends on the one before it:
 *
 *   scan       what is on disk, and what the index already holds
 *   parse      read/hash/diff markdown, build the corpus-wide link maps
 *   persist    one transaction: documents, deletions, the whole link graph
 *   vectors    orphan hygiene, which needs the deletions to have happened
 *   assets     describe images/PDFs (async, billable, failure-tolerant)
 *   embeddings contexts then vectors, for chunks and assets alike
 *   caches     bank descriptions and contexts, then prune what is unreachable
 *   graph      derived tables, which read the links persist just wrote
 *
 * Phases degrade rather than throw. A run with no embedding provider, no
 * enrichment, or no sqlite-vec still produces a correct index — it just
 * produces a smaller one.
 */
import type { Database } from "bun:sqlite";

import { runGraphPrecompute } from "../graph/precompute.js";
import { indexAssets } from "./assets.js";
import { pruneSidecarCaches, saveAssetCache, saveContextCache } from "./caches.js";
import { runEmbeddingPhase } from "./embeddings.js";
import { parseMarkdownFiles } from "./parse.js";
import { persistMarkdown } from "./persist.js";
import { getAssetFiles, getMarkdownFiles, loadExistingDocs } from "./scan.js";
import type { AssetEmbedTask, IndexOptions, IndexRun, IndexStats } from "./types.js";
import { dropMarkdownVectors, dropOrphanedVectors } from "./vectors.js";

function emptyStats(): IndexStats {
  return {
    total: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    chunks: 0,
    embeddings: 0,
    assets: 0,
    graphMs: 0,
    graphNodes: 0,
  };
}

/**
 * Build the context every phase shares.
 *
 * `quiet` is resolved into `report`/`warn` here and nowhere else, so no phase
 * has to remember the `if (!quiet)` guard — the old version had 24 of them and
 * two console calls that had lost theirs.
 */
function createRun(db: Database, options: IndexOptions): IndexRun {
  const quiet = options.quiet ?? false;
  return {
    db,
    root: options.root,
    taxonomy: options.taxonomy,
    force: options.force ?? false,
    wantEmbeddings: options.embeddings ?? false,
    provider: options.provider,
    enrichment: options.enrichment,
    now: new Date().toISOString(),
    stats: emptyStats(),
    report: quiet ? () => {} : (message) => console.log(message),
    warn: quiet ? () => {} : (message) => console.warn(message),
  };
}

/**
 * Rebuild the derived graph tables.
 *
 * Last, because it reads the link graph this run just wrote. A failure here
 * costs the graph view, not the index: the tables stay at the previous run's
 * state and `brain graph compute` can rebuild them on demand.
 */
function precomputeGraph(run: IndexRun): void {
  try {
    const graph = runGraphPrecompute(run.db, { root: run.root, taxonomy: run.taxonomy });
    run.stats.graphMs = graph.durationMs;
    run.stats.graphNodes = graph.nodes;
    run.report(
      `Graph: ${graph.nodes} nodes, ${graph.edges} edges, ${graph.communities} communities (${graph.durationMs}ms)`
    );
  } catch (e) {
    run.warn(`  Graph precompute failed: ${(e as Error).message}`);
  }
}

/**
 * Write the sidecar caches back out.
 *
 * Unconditional at the end of an embeddings run, including one that refused to
 * embed: it mirrors the database, so this also bootstraps the caches on a run
 * where nothing changed, and banks any asset descriptions produced above.
 */
function saveSidecarCaches(run: IndexRun): void {
  try {
    saveContextCache(run.db, run.root);
    saveAssetCache(run.db, run.root);
  } catch (e) {
    run.warn(`  Could not write sidecar caches: ${(e as Error).message}`);
  }
}

/** Incrementally index all markdown files (and assets) into the database. */
export async function indexAll(db: Database, options: IndexOptions): Promise<IndexStats> {
  const run = createRun(db, options);

  // --- scan ---------------------------------------------------------------
  const markdownFiles = getMarkdownFiles(run.root, run.taxonomy);
  run.stats.total = markdownFiles.length;
  // Assets are scanned once and reused three times: deletion detection, the
  // asset phase, and the embedding backfill.
  const assetFiles = getAssetFiles(run.root, run.taxonomy);
  const assetsOnDisk = new Set(assetFiles.map((a) => a.path));
  const existingDocs = loadExistingDocs(run.db);

  // --- parse --------------------------------------------------------------
  const parsed = parseMarkdownFiles(run, markdownFiles, existingDocs);

  // Before the write, not after: dropping markdown vectors is a virtual-table
  // operation and cannot join the transaction below.
  if (run.force) dropMarkdownVectors(run.db);

  // --- persist ------------------------------------------------------------
  const { docIdsNeedingEmbedding } = persistMarkdown(
    run,
    parsed,
    existingDocs,
    new Set(markdownFiles),
    assetsOnDisk
  );

  dropOrphanedVectors(run.db);

  run.report(
    `Indexed: ${run.stats.added} added, ${run.stats.updated} updated, ` +
      `${run.stats.deleted} deleted, ${run.stats.unchanged} unchanged, ${run.stats.chunks} chunks`
  );

  // --- assets + embeddings ------------------------------------------------
  // Describing an asset is only worth paying for if something will vectorize
  // it, so the asset phase rides along with the embedding request.
  let assetQueue: AssetEmbedTask[] = [];
  if (run.wantEmbeddings) {
    assetQueue = await indexAssets(run, assetFiles, existingDocs, assetsOnDisk);
  }

  const embeddingPhaseRan = await runEmbeddingPhase(
    run,
    docIdsNeedingEmbedding,
    assetQueue,
    assetsOnDisk
  );
  if (embeddingPhaseRan) saveSidecarCaches(run);

  // --- caches -------------------------------------------------------------
  // Pruning runs on EVERY run, not just embeddings ones: a deleted asset's
  // description lives in a tracked file until something removes it, and
  // `brain index` is the only thing that knows what is still reachable.
  const pruned = pruneSidecarCaches(run.db, run.root, run.warn);
  if (pruned.assets || pruned.contexts) {
    run.report(`  Pruned ${pruned.assets} asset and ${pruned.contexts} context cache entries`);
  }

  // --- graph --------------------------------------------------------------
  if (options.graph !== false) precomputeGraph(run);

  return run.stats;
}
