/**
 * The indexer's public face.
 *
 * The implementation is a pipeline of phases under `indexer/`; start at
 * `indexer/run.ts`, which is the whole flow in one screen. This module exists
 * so the rest of core (and the package entry) keeps importing one stable name
 * regardless of how the phases are arranged behind it.
 */
export { indexAll } from "./indexer/run.js";
export { getMarkdownFiles, getAssetFiles } from "./indexer/scan.js";
export { extractWikiLinks, resolveWikiLink, resolveAlias } from "./indexer/links.js";
export { chunkContextKey } from "./indexer/caches.js";
export { forgetCachedEnrichment } from "./indexer/forget.js";
export { compactVectors, needsCompaction, readVectorSlots, type VectorSlots } from "./indexer/compact.js";
export type { IndexStats, IndexOptions } from "./indexer/types.js";
