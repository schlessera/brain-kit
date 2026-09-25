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
 *   checkpoint truncate the WAL the run grew, when no reader is in the way
 *
 * Phases degrade rather than throw. A run with no embedding provider, no
 * enrichment, or no sqlite-vec still produces a correct index — it just
 * produces a smaller one.
 */
import type { Database } from "bun:sqlite";

import { runGraphPrecompute, runGraphPrecomputeIfChanged } from "../graph/precompute.js";
import { indexAssets } from "./assets.js";
import { pruneSidecarCaches, saveAssetCache, saveContextCache } from "./caches.js";
import { runEmbeddingPhase } from "./embeddings.js";
import { acquireEmbeddingLock } from "./embedding-lock.js";
import { parseMarkdownFiles } from "./parse.js";
import { persistMarkdown } from "./persist.js";
import { getAssetFiles, getMarkdownFiles, loadExistingDocs } from "./scan.js";
import type { AssetEmbedTask, IndexOptions, IndexRun, IndexStats } from "./types.js";
import { carryMarkdownVectors, dropMarkdownVectors, dropOrphanedVectors, syncVectorFilters } from "./vectors.js";

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
 * `quiet` suppresses progress on stdout, never diagnostics on stderr. JSON
 * callers receive the stable stats object and can still detect partial runs.
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
    warn: (message) => console.warn(message),
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
    const compute = run.force ? runGraphPrecompute : runGraphPrecomputeIfChanged;
    const graph = compute(run.db, { root: run.root, taxonomy: run.taxonomy });
    if (!graph) {
      run.report("Graph: unchanged, reused cached metrics and layout");
      return;
    }
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
 * embed: it appends what the database has and the files lack, so this also
 * bootstraps the caches on a run where nothing changed, and banks any asset
 * descriptions produced above. It never removes or rewrites a line, so a run
 * with nothing new leaves both files untouched.
 */
function saveSidecarCaches(run: IndexRun): void {
  try {
    saveContextCache(run.db, run.root);
    saveAssetCache(run.db, run.root);
  } catch (e) {
    run.warn(`  Could not write sidecar caches: ${(e as Error).message}`);
  }
}

/**
 * Fold the WAL back into `brain.db` and truncate it to zero bytes.
 *
 * An index run is the largest writer core has, and without this the WAL keeps
 * its size until every connection closes. It runs whether the run finished or
 * threw: a run that failed in its asset or embedding phase has still committed
 * its markdown. Best-effort, and it never throws, so it cannot replace the
 * error of a run that failed. Another connection holding a read transaction,
 * the write lock or a checkpoint of its own makes it busy, and waiting out the
 * 5 s busy timeout for that would stall every hook run. The run reports it and
 * moves on; the next run, or SQLite's own checkpoints under
 * `journal_size_limit`, catch up.
 */
function checkpointWal(run: IndexRun): void {
  let timeout: number | undefined;
  try {
    timeout = (run.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    run.db.run("PRAGMA busy_timeout=0");
    const result = run.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
    if (result?.busy) {
      run.report("WAL checkpoint busy: another connection holds a lock; the WAL is left for a later run");
    }
  } catch (e) {
    run.report(`WAL checkpoint skipped: ${(e as Error).message}`);
  } finally {
    try {
      if (timeout !== undefined) run.db.run(`PRAGMA busy_timeout=${timeout}`);
    } catch (e) {
      run.warn(`  Could not restore the busy timeout: ${(e as Error).message}`);
    }
  }
}

/** Incrementally index all markdown files (and assets) into the database. */
export async function indexAll(db: Database, options: IndexOptions): Promise<IndexStats> {
  // Claim before even the force wipe or asset descriptions. Plain FTS index
  // runs can still update content while the provider is working; embedding
  // writes revalidate their captured chunks before committing.
  const release = options.embeddings ? acquireEmbeddingLock(db) : undefined;
  try {
    return await runIndex(db, options);
  } finally {
    release?.();
  }
}

async function runIndex(db: Database, options: IndexOptions): Promise<IndexStats> {
  const run = createRun(db, options);
  try {
    return await runPipeline(run, options);
  } finally {
    // --- checkpoint -------------------------------------------------------
    checkpointWal(run);
  }
}

async function runPipeline(run: IndexRun, options: IndexOptions): Promise<IndexStats> {

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

  // Drop vectors while their old markdown chunk IDs still exist, before the
  // persist phase replaces those chunks. Whatever the embedding phase can
  // reuse is held in memory first.
  if (run.force) {
    if (run.wantEmbeddings && run.provider) run.carriedVectors = carryMarkdownVectors(run.db, run.provider);
    dropMarkdownVectors(run.db);
  }

  // --- persist ------------------------------------------------------------
  persistMarkdown(
    run,
    parsed,
    existingDocs,
    new Set(markdownFiles),
    assetsOnDisk
  );

  dropOrphanedVectors(run.db);
  syncVectorFilters(run.db);

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

  const embeddingPhaseRan = await runEmbeddingPhase(run, assetQueue, assetsOnDisk);
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
