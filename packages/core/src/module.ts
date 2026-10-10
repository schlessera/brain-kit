/**
 * `@schlessera/brain/module` — the helpers a module needs to touch the brain's
 * files the way core does: path containment, atomic writes, the scratch area,
 * frontmatter splitting, generated regions, the corpus walk, the index
 * registry, and the configured completion provider. The manifest API
 * (`defineModule`, `CommandContext` …) stays in `@schlessera/brain`; index
 * reads go through `ctx.queries` or `@schlessera/brain/queries`.
 *
 * Supported API, including every type these signatures reach
 * (docs/decisions/public-export-boundary.md), ruled on #537. First-party
 * modules use this entry, never `@schlessera/brain/internal`.
 *
 * @experimental Until 1.0; follows the shared integration contract.
 */

// Path containment and atomic writes
export { safeResolve, resolveWritable, writeFileSafely, WriteRefusedError } from "./lib/safe-path.js";
export type { WriteFileSafelyOptions } from "./lib/safe-path.js";

// The scratch area (.brain/scratch)
export {
  SCRATCH_DIR,
  assertScratchWritable,
  isInScratch,
  isWriteRefusal,
  pruneScratch,
  scratchName,
  writeScratchFile,
} from "./lib/scratch.js";
export type { ScratchReport, ScratchRemoval, ScratchFailure } from "./lib/scratch.js";

// Frontmatter and generated regions
export { splitFrontmatterBlock, rewriteGeneratedRegion, inertGeneratedText } from "./lib/generated-regions.js";

// Taxonomy, the corpus walk and the index registry
export { buildTaxonomy } from "./lib/taxonomy.js";
export { getMarkdownFiles } from "./lib/indexer.js";
export { runRegistry } from "./lib/index-registry.js";
export type { RegistryRun, RegistryProblem } from "./lib/index-registry.js";
export type { ValidationIssue } from "./lib/validate.js";

// Completion providers: resolve `CommandContext.completions`, or the built-in
// Gemini provider with a module-chosen model.
export { resolveCompletionProvider } from "./lib/registry.js";
export { geminiCompletions } from "./providers/completions/gemini.js";
export type { GeminiCompletionConfig } from "./providers/completions/gemini.js";
export { GEMINI_FLASH_MODEL } from "./lib/llm-defaults.js";
