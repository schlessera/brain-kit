/**
 * @schlessera/brain public API.
 *
 * Everything a brain.config.ts, a module package, or an embedding host needs.
 * CLI/MCP entry points live in src/cli/ and src/mcp-server.ts (bin surface,
 * not importable API).
 */

// Config authoring + loading
export {
  defineConfig,
  brainConfigSchema,
  repoRelativePathSchema,
  resolveRoot,
  loadUserConfig,
  formatConfigError,
  CORE_TYPES,
  DEFAULT_CANONICAL,
  DEFAULT_DIR_ANCHORS,
  DEFAULT_EXCLUDE,
  DEFAULT_STALENESS,
} from "./lib/config.js";
export type {
  BrainConfig,
  TaxonomyConfig,
  TypeSpec,
  PropagationRule,
  AssetTitleRule,
  LoadedConfig,
} from "./lib/config.js";

// Modules
export { defineModule } from "./lib/module-types.js";
export type {
  ModuleManifest,
  ModuleCronEntry,
  LoadedModule,
  HygieneContext,
  CommandModule,
  CommandContext,
} from "./lib/module-types.js";
export { loadModules } from "./lib/module-loader.js";

// Taxonomy
export { buildTaxonomy, Taxonomy } from "./lib/taxonomy.js";
export type { ResolvedTypeSpec, StalenessVerdict, Severity } from "./lib/taxonomy.js";

// Context
export { initContext, getContext, setContext } from "./lib/context.js";
export type { BrainContext, InitContextOptions } from "./lib/context.js";

// Extension seams (@experimental until 1.0)
export {
  defineEmbeddingProvider,
  defineCompletionProvider,
  defineAgentRunner,
  defineSkillEmitter,
} from "./lib/seams.js";
export type {
  CompletionProvider,
  EmbeddingProvider,
  AgentRunner,
  SkillEmitter,
  SkillManifest,
  ContentPart,
} from "./lib/seams.js";

// Database + search
export {
  openDatabase,
  loadVecSupport,
  migrateVecSchema,
  storedVectorWidth,
  hasVecSupport,
  getMeta,
  setMeta,
  SCHEMA_VERSION,
} from "./lib/db.js";
export type { SchemaOptions, VecSupport, VecUnavailableReason } from "./lib/db.js";
export { hybridSearch, filterSearch, isIsoDate } from "./lib/search-engine.js";
export { readDocumentPart, SectionNotFoundError } from "./lib/document-parts.js";
export type { ReadPartOptions } from "./lib/document-parts.js";
export type { SearchDeps, SearchResponse } from "./lib/search-engine.js";
export { assembleContext, estimateTokens } from "./lib/context-assembler.js";
export type { AssembleOptions } from "./lib/context-assembler.js";
// Exported so a retrieval-quality harness can score rerank-on and rerank-off
// orderings from one candidate list instead of re-embedding the query.
export { rerank, getDefaultRerankerMode } from "./lib/reranker.js";
export type { RerankerConfig } from "./lib/reranker.js";

// Indexing + content pipeline
export {
  indexAll,
  getMarkdownFiles,
  getAssetFiles,
  extractWikiLinks,
  resolveWikiLink,
} from "./lib/indexer.js";
export type { IndexStats, IndexOptions } from "./lib/indexer.js";
export { ingest, classifyContent } from "./lib/ingestion.js";
export type { IngestOutcome, IngestContext, Classification } from "./lib/ingestion.js";
export { audit } from "./lib/auditor.js";
export { collectStats } from "./lib/stats.js";
export type { BrainStats, CollectStatsOptions, StatsThresholds } from "./lib/stats.js";
export type { AuditOptions } from "./lib/auditor.js";
export { validate, checkIndexDrift } from "./lib/validate.js";
export type { ValidationIssue } from "./lib/validate.js";
export { archiveDocument, relevanceOnArchive } from "./lib/archiver.js";
export type { ArchiveOptions, ArchiveResult } from "./lib/archiver.js";
export { chunkDocument, chunkTextForEmbedding } from "./lib/chunker.js";
export { stringifyDocument, normalizeFrontmatterDates } from "./lib/frontmatter.js";
export { editFrontmatter, updateDocument } from "./lib/frontmatter-edit.js";
export type { FrontmatterValue } from "./lib/frontmatter-edit.js";
export { resolveWritable, safeResolve, WriteRefusedError, writeFileSafely } from "./lib/safe-path.js";
export {
  SCRATCH_DIR,
  SCRATCH_MAX_BYTES,
  SCRATCH_TTL_MS,
  ScratchNotIgnoredError,
  ScratchRedirectedError,
  assertScratchWritable,
  cleanScratch,
  ensureScratch,
  ignoreScratch,
  isInScratch,
  isWriteRefusal,
  pruneScratch,
  scratchDir,
  scratchIgnored,
  scratchName,
  writeScratchFile,
  type ScratchFailure,
  type ScratchRemoval,
  type ScratchReport,
} from "./lib/scratch.js";
export { exportOkfBundle, checkOkfBundle, OkfExportError } from "./lib/okf-exporter.js";
export type {
  OkfExportOptions,
  OkfExportReport,
  OkfDegradedLink,
  OkfCheckReport,
  OkfCheckIssue,
} from "./lib/okf-exporter.js";

// Providers + enrichment
export { createEnrichment } from "./lib/enrichment.js";
export type { Enrichment } from "./lib/enrichment.js";
export {
  resolveEmbeddingProvider,
  resolveCompletionProvider,
  resolveAgentRunner,
} from "./lib/registry.js";

// Skills distribution
export { discoverSkills } from "./lib/skills/discover.js";
export { syncSkills, installBinLinks } from "./lib/skills/sync.js";
export { lintSkills } from "./lib/skills/lint.js";
export { BUILTIN_EMITTERS } from "./lib/skills/index.js";

// Data types
export type {
  Document,
  DocumentType,
  DocumentStatus,
  DocumentRelevance,
  Chunk,
  ChunkMatch,
  SearchResult,
  SearchOptions,
  AuditIssue,
  IngestInput,
  Asset,
} from "./lib/types.js";
export { VALID_STATUSES, VALID_RELEVANCES, ASSET_EXTENSIONS, SEARCH_SORTS } from "./lib/types.js";

// Environment contract (chokepoint: src/config/env.ts)
export { ENV_VARS, DYNAMIC_ENV_READS, resolveEnv, readEnvVar } from "./config/env.js";
export type { EnvVarSpec, DynamicEnvReadSpec, CoreEnv } from "./config/env.js";
