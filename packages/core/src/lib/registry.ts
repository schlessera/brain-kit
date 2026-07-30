/**
 * Built-in provider registries + config resolvers.
 *
 * The dual convention IS the mechanism (plan/04 §0): a config entry is either a
 * string (name of a built-in, resolved against a static registry compiled into
 * core) or a passed-in implementation value (used as-is). Third parties never
 * touch these registries — they export a factory the user imports and passes.
 */

import type { BrainConfig } from "./config.js";
import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "./seams.js";

import { geminiEmbeddings, type GeminiEmbeddingConfig } from "../providers/embeddings/gemini.js";
import { geminiCompletions } from "../providers/completions/gemini.js";
import { anthropicCompletions } from "../providers/completions/anthropic.js";
import {
  claudeRunner,
  codexRunner,
  geminiRunner,
  piRunner,
} from "../providers/agents/cli-runners.js";

type EmbeddingsConfig = NonNullable<BrainConfig["embeddings"]>;
type CompletionsConfig = NonNullable<BrainConfig["completions"]>;
type AgentRunnerConfig = NonNullable<BrainConfig["agentRunner"]>;

// ---------------------------------------------------------------------------
// Registries (string → factory)
// ---------------------------------------------------------------------------

export const EMBEDDING_PROVIDERS: Record<
  string,
  (config: GeminiEmbeddingConfig) => EmbeddingProvider
> = {
  gemini: (config) => geminiEmbeddings(config),
};

export const COMPLETION_PROVIDERS: Record<string, () => CompletionProvider> = {
  "gemini-flash": () => geminiCompletions(),
  "anthropic-haiku": () => anthropicCompletions(),
};

export const AGENT_RUNNERS: Record<string, () => AgentRunner> = {
  claude: claudeRunner,
  pi: piRunner,
  codex: codexRunner,
  gemini: geminiRunner,
};

function unknownMessage(
  kind: string,
  name: string,
  registry: Record<string, unknown>,
  iface: string
): string {
  const available = Object.keys(registry).sort().join(", ");
  return `Unknown ${kind} "${name}". Available built-ins: ${available}. Pass a custom ${iface} value instead.`;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/** Default built-in when no embeddings config is present. */
export function resolveEmbeddingProvider(config?: EmbeddingsConfig): EmbeddingProvider {
  if (!config) return geminiEmbeddings();

  const { provider, model, apiKeyEnv, dimensions } = config;
  if (typeof provider !== "string") return provider; // custom value, used as-is

  const factory = EMBEDDING_PROVIDERS[provider];
  if (!factory) {
    throw new Error(unknownMessage("embedding provider", provider, EMBEDDING_PROVIDERS, "EmbeddingProvider"));
  }
  return factory({ model, apiKeyEnv, dimensions });
}

function resolveCompletionEntry(entry: string | CompletionProvider): CompletionProvider {
  if (typeof entry !== "string") return entry; // custom value, used as-is

  const factory = COMPLETION_PROVIDERS[entry];
  if (!factory) {
    throw new Error(unknownMessage("completion provider", entry, COMPLETION_PROVIDERS, "CompletionProvider"));
  }
  return factory();
}

/**
 * A completion provider that tries `primary`, then `fallback` on any error.
 * Advertises the primary's capabilities (the main path); pair it with a
 * fallback at least as capable.
 */
function withFallback(
  primary: CompletionProvider,
  fallback: CompletionProvider
): CompletionProvider {
  return {
    id: `${primary.id}+fallback:${fallback.id}`,
    capabilities: { vision: primary.capabilities.vision },
    async complete(req) {
      try {
        return await primary.complete(req);
      } catch {
        return await fallback.complete(req);
      }
    },
  };
}

/** Default built-in is "gemini-flash"; a configured fallback wraps the primary. */
export function resolveCompletionProvider(config?: CompletionsConfig): CompletionProvider {
  const primary = resolveCompletionEntry(config?.provider ?? "gemini-flash");
  if (config?.fallback === undefined) return primary;
  return withFallback(primary, resolveCompletionEntry(config.fallback));
}

/** Default built-in when no agentRunner config is present. */
export function resolveAgentRunner(config?: AgentRunnerConfig): AgentRunner {
  const entry = config ?? "claude";
  if (typeof entry !== "string") return entry; // custom value, used as-is

  const factory = AGENT_RUNNERS[entry];
  if (!factory) {
    throw new Error(unknownMessage("agent runner", entry, AGENT_RUNNERS, "AgentRunner"));
  }
  return factory();
}
