/**
 * Shared CLI types. Kept separate from registry.ts so command modules can
 * import CliContext/CoreCommand without a runtime import cycle through the
 * registry (which imports the commands).
 */

import type { BrainContext } from "../lib/context.js";
import type { Enrichment } from "../lib/enrichment.js";
import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "../lib/seams.js";

/**
 * Everything a core command needs beyond its arguments. Assembled once by the
 * bin entry: the initialized brain context, the output mode, and the resolved
 * providers (each undefined when its API key is absent, so features degrade to
 * the same keyless behaviour the reference brain had without a configured key).
 */
export interface CliContext {
  brain: BrainContext;
  /** True = emit JSON; false = human-readable. */
  json: boolean;
  /** Set when the brain.config failed schema validation (initContext threw). */
  configError?: string;
  /** Original failure, retained only for commands that diagnose rejected config. */
  configCause?: unknown;
  embeddings?: EmbeddingProvider;
  completions?: CompletionProvider;
  enrichment?: Enrichment;
  agentRunner?: AgentRunner;
}

/** A core command implementation. Modules use the public CommandModule instead. */
export interface CoreCommand {
  summary: string;
  helpBlock?: string;
  run(args: string[], cli: CliContext): Promise<number | void>;
}
