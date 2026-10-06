/**
 * First-party implementation sharing between brain-kit packages: the
 * native-handle search/context/write helpers pi uses, and the path-safety,
 * scratch, generated-region and taxonomy helpers the modules use. Not a
 * supported API: no compatibility guarantee, and consumers must use the same
 * lockstep version (docs/decisions/public-export-boundary.md). Content-index
 * reads use @schlessera/brain/queries instead of this entry.
 */
export { archiveDocument } from "./lib/archiver.js";
export { assembleContext } from "./lib/context-assembler.js";
export { loadVecSupport, openDatabase } from "./lib/db.js";
export { indexAll } from "./lib/indexer.js";
export { ingest } from "./lib/ingestion.js";
export { hybridSearch } from "./lib/search-engine.js";
export { relevanceOnArchive } from "./lib/archiver.js";
export type { ArchiveResult } from "./lib/archiver.js";
export { estimateTokens } from "./lib/context-assembler.js";
export { initContext } from "./lib/context.js";
export type { BrainContext } from "./lib/context.js";
export { readDocumentPart } from "./lib/document-parts.js";
export { updateDocument } from "./lib/frontmatter-edit.js";
export type { FrontmatterValue } from "./lib/frontmatter-edit.js";
export { inertGeneratedText, rewriteGeneratedRegion, splitFrontmatterBlock } from "./lib/generated-regions.js";
export { runRegistry } from "./lib/index-registry.js";
export { getMarkdownFiles } from "./lib/indexer.js";
export type { IngestOutcome } from "./lib/ingestion.js";
export { rerankSetup, resolveEmbeddingProvider } from "./lib/registry.js";
export { WriteRefusedError, resolveWritable, safeResolve, writeFileSafely } from "./lib/safe-path.js";
export { SCRATCH_DIR, assertScratchWritable, isInScratch, isWriteRefusal, pruneScratch, scratchName, writeScratchFile } from "./lib/scratch.js";
export { isIsoDate } from "./lib/search-engine.js";
export type { SearchResponse } from "./lib/search-engine.js";
export { collectStats } from "./lib/stats.js";
export type { CollectStatsOptions } from "./lib/stats.js";
export { buildTaxonomy } from "./lib/taxonomy.js";
export { SEARCH_SORTS } from "./lib/types.js";
export type { IngestInput, SearchOptions } from "./lib/types.js";
export type { ValidationIssue } from "./lib/validate.js";
