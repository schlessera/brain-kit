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
