/**
 * @brainform/core public API.
 *
 * Everything a brain.config.ts, a module package, or an embedding host needs.
 * CLI/MCP entry points live in src/cli/ and src/mcp-server.ts (bin surface,
 * not importable API).
 */

// Config authoring + loading
export {
  defineConfig,
  brainConfigSchema,
  resolveRoot,
  loadUserConfig,
  formatConfigError,
  CORE_TYPES,
  DEFAULT_CANONICAL,
  DEFAULT_DIR_ANCHORS,
  DEFAULT_EXCLUDE,
  DEFAULT_STALENESS,
} from "./lib/config";
export type {
  BrainConfig,
  TaxonomyConfig,
  TypeSpec,
  PropagationRule,
  AssetTitleRule,
  LoadedConfig,
} from "./lib/config";

// Modules
export { defineModule } from "./lib/module-types";
export type {
  ModuleManifest,
  ModuleCronEntry,
  LoadedModule,
  HygieneContext,
  CommandModule,
  CommandContext,
} from "./lib/module-types";
export { loadModules } from "./lib/module-loader";

// Taxonomy
export { buildTaxonomy, Taxonomy } from "./lib/taxonomy";
export type { ResolvedTypeSpec, StalenessVerdict, Severity } from "./lib/taxonomy";

// Context
export { initContext, getContext, setContext } from "./lib/context";
export type { BrainContext, InitContextOptions } from "./lib/context";

// Extension seams (@experimental until 1.0)
export type {
  CompletionProvider,
  EmbeddingProvider,
  AgentRunner,
  SkillEmitter,
  SkillManifest,
  ContentPart,
} from "./lib/seams";

// Database + search
export { openDatabase, initVecSupport, hasVecSupport, getMeta, setMeta } from "./lib/db";
export type { SchemaOptions } from "./lib/db";
export { hybridSearch, filterSearch } from "./lib/search-engine";
export type { SearchDeps, SearchResponse } from "./lib/search-engine";

// Indexing + content pipeline
export {
  indexAll,
  getMarkdownFiles,
  getAssetFiles,
  extractWikiLinks,
  resolveWikiLink,
} from "./lib/indexer";
export type { IndexStats, IndexOptions } from "./lib/indexer";
export { ingest, classifyContent } from "./lib/ingestion";
export type { IngestOutcome, IngestContext, Classification } from "./lib/ingestion";
export { audit } from "./lib/auditor";
export type { AuditOptions } from "./lib/auditor";
export { validate, checkIndexDrift } from "./lib/validate";
export type { ValidationIssue } from "./lib/validate";
export { archiveDocument } from "./lib/archiver";
export type { ArchiveOptions, ArchiveResult } from "./lib/archiver";
export { chunkDocument, chunkTextForEmbedding } from "./lib/chunker";
export { stringifyDocument, normalizeFrontmatterDates } from "./lib/frontmatter";
export { safeResolve } from "./lib/safe-path";

// Providers + enrichment
export { createEnrichment } from "./lib/enrichment";
export type { Enrichment } from "./lib/enrichment";
export {
  resolveEmbeddingProvider,
  resolveCompletionProvider,
  resolveAgentRunner,
} from "./lib/registry";

// Skills distribution
export { discoverSkills } from "./lib/skills/discover";
export { syncSkills, installBinLinks } from "./lib/skills/sync";
export { lintSkills } from "./lib/skills/lint";
export { BUILTIN_EMITTERS } from "./lib/skills";

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
} from "./lib/types";
export { VALID_STATUSES, VALID_RELEVANCES, ASSET_EXTENSIONS } from "./lib/types";
