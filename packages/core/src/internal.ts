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
export { ingest, prepareIngest } from "./lib/ingestion.js";
export { hybridSearch } from "./lib/search-engine.js";
export { relevanceOnArchive } from "./lib/archiver.js";
export type { ArchiveResult } from "./lib/archiver.js";
export { coverageNote, emptyContextCoverage, estimateTokens } from "./lib/context-assembler.js";
export type { ContextCoverage } from "./lib/context-assembler.js";
export { MAX_SCOPE_ENTRIES, MAX_SCOPE_ENTRY_LENGTH } from "./lib/context-scope.js";
export type { ContextScopeInput } from "./lib/context-scope.js";
export { initContext } from "./lib/context.js";
export type { BrainContext } from "./lib/context.js";
export { readDocumentPart } from "./lib/document-parts.js";
// The bounded multi-read pi's brain_read_many adapts (#3642).
export {
  READ_MANY_DESCRIPTION,
  READ_MANY_MAX_PATH_CHARS,
  READ_MANY_MAX_REQUESTS,
  READ_MANY_MAX_SECTION_CHARS,
  READ_MANY_MAX_TOTAL_CHARS,
  READ_MANY_MIN_ITEM_CHARS,
  READ_MANY_MIN_TOTAL_CHARS,
  readMany,
} from "./lib/ops/read-many.js";
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
// Host-only managed-worktree findings (#2431) reuse the hygiene identity, fingerprint and selection rules.
export { canonicalFindings } from "./lib/hygiene.js";
export type { HygieneCandidate, HygieneFinding, HygieneLogEntry } from "./lib/hygiene.js";
export { REVIEW_SEVERITY, REVIEW_URGENCY, reviewUrgency, selectHygieneNext } from "./lib/hygiene-next.js";
export { SEARCH_SORTS } from "./lib/types.js";
export type { IngestInput, SearchOptions } from "./lib/types.js";
export type { ValidationIssue } from "./lib/validate.js";

// Shared by the opt-in video module; these remain first-party implementation APIs.
export { getContext } from "./lib/context.js";
export { resolveCompletionProvider } from "./lib/registry.js";
export { GEMINI_FLASH_MODEL } from "./lib/llm-defaults.js";
export { checkGovernancePolicy, parseGovernancePolicy, resolveGovernancePolicy, GovernancePolicySchema, GOVERNANCE_POLICY_PATH, BUILTIN_GOVERNANCE_POLICY } from "./lib/governance-policy.js";
export type { GovernancePolicyInput, EffectiveGovernancePolicy, GovernancePolicyCheck } from "./lib/governance-policy.js";
export { geminiCompletions } from "./providers/completions/gemini.js";

export { collectModuleRenderers } from "./lib/module-renderers.js";
export type { ResolvedModuleRenderer } from "./lib/module-renderers.js";

// External compute lifecycle for the `brain compute` CLI, MCP and hosted admission (#3105).
export { createComputeService, computeJobView, ComputeStateError, computeBrainKey, resolveComputeStateDir, COMPUTE_JOB_ID } from "./lib/compute/index.js";
export type {
  ComputeService,
  ComputeHealthReport,
  ComputeCollection,
  ComputeReconcileReport,
  ComputeApproval,
  ComputeBudget,
  ComputeCaller,
  ComputeClock,
  ComputeJobView,
  ComputeJobResult,
  ComputePlan,
  ComputeRefusal,
  ComputeRunRequest,
  ComputeServiceOptions,
} from "./lib/compute/index.js";
export { COMPUTE_PROVIDERS, loadComputePackage, resolveComputeInstance } from "./lib/registry.js";
// The operation set and driver a host admits hosted jobs through (#3108).
export {
  COMPUTE_TOOL_NAMES,
  computeHealthInput,
  computeRequestInput,
  computeJobInput,
  createComputeOps,
  createComputeDriver,
  jobOutput,
  jobSettled,
} from "./lib/ops/compute.js";
export type {
  ComputeOps,
  ComputeOpsOptions,
  ComputeDriver,
  ComputeDriverOptions,
  ComputeEnvelope,
  ComputeErrorEnvelope,
  ComputeJobOutput,
  ComputeJobEnvelope,
  ComputeCollectEnvelope,
  ComputePlanEnvelope,
  ComputeHealthEnvelope,
  ComputeHealthInput,
  ComputeRequestInput,
  ComputeJobInput,
} from "./lib/ops/compute.js";
export type { ComputeBuiltin, ResolvedComputeInstance } from "./lib/registry.js";
