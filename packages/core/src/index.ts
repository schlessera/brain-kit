/**
 * @schlessera/brain public API.
 *
 * What a brain.config.ts, a module package or an extension-seam
 * implementation needs; content-index reads are `@schlessera/brain/queries`.
 * Everything exported here, and every type its signatures reach, is supported
 * API (docs/decisions/public-export-boundary.md). First-party sharing lives in
 * `./internal.ts`, with no compatibility promise. CLI/MCP entry points live in
 * src/cli/ and src/mcp-server.ts (bin surface, not importable API).
 */

// Config authoring + loading
export {
  defineConfig,
  repoRelativePathSchema,
} from "./lib/config.js";
export type {
  BrainConfig,
  TaxonomyConfig,
  TypeSpec,
  PropagationRule,
  AssetTitleRule,
} from "./lib/config.js";

// Modules
export { defineModule, defineModuleTool } from "./lib/module-types.js";
export type { ModuleSettings, ModuleSettingsField, ModuleSettingsOption, ModuleSettingsMigrationPlan } from "./lib/module-settings-types.js";
export type {
  ModuleManifest,
  ModuleContribution,
  ModuleTool,
  ToolContext,
  ModuleCronEntry,
  LoadedModule,
  HygieneContext,
  CommandModule,
  CommandContext,
} from "./lib/module-types.js";
export type { ContentIndexQueries } from "./queries/bound.js";

// Taxonomy
export { Taxonomy } from "./lib/taxonomy.js";
export type { ResolvedTypeSpec, StalenessVerdict, Severity } from "./lib/taxonomy.js";

// Extension seams (@experimental until 1.0)
export {
  defineEmbeddingProvider,
  defineCompletionProvider,
  defineAgentRunner,
  defineSkillEmitter,
  defineReranker,
} from "./lib/seams.js";
export type {
  CompletionProvider,
  EmbeddingProvider,
  AgentRunner,
  AgentRuntime,
  SkillEmitter,
  SkillManifest,
  ContentPart,
  Reranker,
  RerankCandidate,
  RerankRequest,
  Ranked,
  SearchMode,
} from "./lib/seams.js";

// The brain.db schema version the CLI reports.
export { SCHEMA_VERSION } from "./lib/db.js";
// So a search that fans out over several sources can run a Reranker over the
// union the way the engine's own search does (exclusion, placement,
// validation); docs/extending/rerankers.md documents them.
export {
  buildPathMatcher,
  partitionForRerank,
  mergeWithheld,
  assertPermutation,
  candidateKey,
} from "./lib/reranker.js";

// Corpus statistics
export { collectStats } from "./lib/stats.js";
export type { BrainStats, CollectStatsOptions, StatsThresholds } from "./lib/stats.js";

// Providers + enrichment
export { createEnrichment } from "./lib/enrichment.js";
export type { Enrichment } from "./lib/enrichment.js";
export { resolveReranker } from "./lib/registry.js";

// Skills distribution
export { syncSkills } from "./lib/skills/sync.js";
export { BUILTIN_EMITTERS } from "./lib/skills/index.js";

// Data types
export type {
  ChunkMatch,
  SearchResult,
  AuditIssue,
} from "./lib/types.js";

// Environment contract (chokepoint: src/config/env.ts)
export { ENV_VARS, DYNAMIC_ENV_READS } from "./config/env.js";
export type { EnvVarSpec, DynamicEnvReadSpec } from "./config/env.js";
