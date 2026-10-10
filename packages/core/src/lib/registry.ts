/**
 * Built-in provider registries + config resolvers.
 *
 * The dual convention IS the mechanism: a config entry is either a
 * string (name of a built-in, resolved against a static registry compiled into
 * core) or a passed-in implementation value (used as-is). Third parties never
 * touch these registries — they export a factory the user imports and passes.
 */

import type { BrainConfig } from "./config.js";
import type { AgentRunner, CompletionProvider, EmbeddingProvider, Reranker } from "./seams.js";
import { readEnvVar } from "../config/env.js";
import { buildPathMatcher, envRerankMode, isRerankMode, RERANK_MODES } from "./reranker.js";
import { jevReranker, JEV_API_KEY_ENV, type JevRerankerConfig } from "../providers/rerankers/jev.js";

import {
  geminiEmbeddings,
  GEMINI_EMBEDDINGS_KEY_ENV,
  type GeminiEmbeddingConfig,
} from "../providers/embeddings/gemini.js";
import { geminiCompletions, GEMINI_COMPLETIONS_KEY_ENV } from "../providers/completions/gemini.js";
import { anthropicCompletions, ANTHROPIC_KEY_ENV } from "../providers/completions/anthropic.js";
import {
  claudeRunner,
  codexRunner,
  geminiRunner,
  piRunner,
} from "../providers/agents/cli-runners.js";

type EmbeddingsConfig = NonNullable<BrainConfig["embeddings"]>;
type CompletionsConfig = NonNullable<BrainConfig["completions"]>;
type AgentRunnerConfig = NonNullable<BrainConfig["agentRunner"]>;
type RerankerSettings = NonNullable<BrainConfig["reranker"]>;

// ---------------------------------------------------------------------------
// Registries (string → factory)
// ---------------------------------------------------------------------------

/** A keyed built-in: its factory, and the env var it reads its key from by default. */
export interface KeyedBuiltin<C, P> {
  keyEnv: string;
  create: (config: C) => P;
}

export const DEFAULT_EMBEDDING_PROVIDER = "gemini";
export const DEFAULT_COMPLETION_PROVIDER = "gemini-flash";

export const EMBEDDING_PROVIDERS: Record<string, KeyedBuiltin<GeminiEmbeddingConfig, EmbeddingProvider>> = {
  gemini: { keyEnv: GEMINI_EMBEDDINGS_KEY_ENV, create: (config) => geminiEmbeddings(config) },
};

export const COMPLETION_PROVIDERS: Record<string, KeyedBuiltin<{ apiKeyEnv?: string }, CompletionProvider>> = {
  "gemini-flash": { keyEnv: GEMINI_COMPLETIONS_KEY_ENV, create: (config) => geminiCompletions(config) },
  "anthropic-haiku": { keyEnv: ANTHROPIC_KEY_ENV, create: (config) => anthropicCompletions(config) },
};

/**
 * Judgment rerankers, by name. `jev` is the default provider when enabled and needs a
 * key; without one, search keeps the lifecycle ordering (`heuristic`).
 * "heuristic" and "none" are accepted wherever a name is and are not
 * rerankers: they select the lifecycle factors alone, or nothing.
 */
/**
 * Default `reranker.skipMargin`: none. The gate is a cost lever that measured
 * neutral to negative on quality (see SearchDeps.rerankSkipMargin). Activated
 * search skips no judgment by vector margin unless a brain configures it.
 */
export const DEFAULT_RERANK_SKIP_MARGIN: number | undefined = undefined;

export const RERANKERS: Record<string, (config: JevRerankerConfig) => Reranker> = {
  jev: (config) => jevReranker(config),
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
  const { provider, model, apiKeyEnv, dimensions } = config ?? { provider: DEFAULT_EMBEDDING_PROVIDER };
  if (typeof provider !== "string") return provider; // custom value, used as-is

  const builtin = Object.hasOwn(EMBEDDING_PROVIDERS, provider) ? EMBEDDING_PROVIDERS[provider] : undefined;
  if (!builtin) {
    throw new Error(unknownMessage("embedding provider", provider, EMBEDDING_PROVIDERS, "EmbeddingProvider"));
  }
  return builtin.create({ model, apiKeyEnv, dimensions });
}

function resolveCompletionEntry(
  entry: string | CompletionProvider,
  apiKeyEnv: string | undefined
): CompletionProvider {
  if (typeof entry !== "string") return entry; // custom value, used as-is

  const builtin = Object.hasOwn(COMPLETION_PROVIDERS, entry) ? COMPLETION_PROVIDERS[entry] : undefined;
  if (!builtin) {
    throw new Error(unknownMessage("completion provider", entry, COMPLETION_PROVIDERS, "CompletionProvider"));
  }
  return builtin.create(apiKeyEnv ? { apiKeyEnv } : {});
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
    capabilities: { vision: primary.capabilities.vision, video: primary.capabilities.video ?? false },
    async complete(req) {
      try {
        return await primary.complete(req);
      } catch (error) {
        // Video must not silently move to another provider, nor retry after cancellation.
        if (req.signal?.aborted || req.parts?.some((part) => part.kind === "video")) throw error;
        return await fallback.complete(req);
      }
    },
  };
}

/** Default built-in is "gemini-flash"; a configured fallback wraps the primary. */
export function resolveCompletionProvider(config?: CompletionsConfig): CompletionProvider {
  const primary = resolveCompletionEntry(config?.provider ?? DEFAULT_COMPLETION_PROVIDER, config?.apiKeyEnv);
  if (config?.fallback === undefined) return primary;
  return withFallback(primary, resolveCompletionEntry(config.fallback, config.fallbackApiKeyEnv));
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

// ---------------------------------------------------------------------------
// Availability: decided here, once, for the CLI, the MCP server and doctor
// ---------------------------------------------------------------------------

/**
 * The unset env var that keeps a configured entry off, or undefined when it
 * may be resolved: a custom value, a built-in whose key is set, or an unknown
 * name, which the resolver reports.
 */
function unsetKey(
  registry: Record<string, KeyedBuiltin<never, unknown>>,
  entry: unknown,
  apiKeyEnv: string | undefined
): string | undefined {
  if (typeof entry !== "string") return undefined;
  const env = apiKeyEnv ?? (Object.hasOwn(registry, entry) ? registry[entry].keyEnv : undefined);
  return env !== undefined && !readEnvVar(env) ? env : undefined;
}

/** The unset key variable that keeps the configured embedding provider off. */
export function missingEmbeddingKey(config?: EmbeddingsConfig): string | undefined {
  return unsetKey(EMBEDDING_PROVIDERS, config ? config.provider : DEFAULT_EMBEDDING_PROVIDER, config?.apiKeyEnv);
}

export interface ResolvedProviders {
  embeddings?: EmbeddingProvider;
  completions?: CompletionProvider;
  agentRunner?: AgentRunner;
  /** Why a seam could not be resolved, by seam, for each host to report its own way. */
  warnings: { embeddings?: string; completions?: string; agentRunner?: string };
}

/**
 * Resolve the providers a host runs with. A built-in is left undefined when
 * its key is absent, so search, index and enrichment degrade to keyless
 * behaviour; a completion config is available when its primary or its
 * fallback is. A resolution error (an unknown built-in name) leaves the seam
 * undefined with a warning instead of throwing.
 */
export function resolveProviders(config?: BrainConfig | null): ResolvedProviders {
  const resolved: ResolvedProviders = { warnings: {} };
  try {
    if (!missingEmbeddingKey(config?.embeddings)) resolved.embeddings = resolveEmbeddingProvider(config?.embeddings);
  } catch (e) {
    resolved.warnings.embeddings = `embedding provider unavailable — ${(e as Error).message}`;
  }
  try {
    const cfg = config?.completions;
    const available =
      !unsetKey(COMPLETION_PROVIDERS, cfg?.provider ?? DEFAULT_COMPLETION_PROVIDER, cfg?.apiKeyEnv) ||
      (cfg?.fallback !== undefined && !unsetKey(COMPLETION_PROVIDERS, cfg.fallback, cfg.fallbackApiKeyEnv));
    if (available) resolved.completions = resolveCompletionProvider(cfg);
  } catch (e) {
    resolved.warnings.completions = `completion provider unavailable — ${(e as Error).message}`;
  }
  try {
    resolved.agentRunner = resolveAgentRunner(config?.agentRunner);
  } catch (e) {
    resolved.warnings.agentRunner = `agent runner unavailable — ${(e as Error).message}`;
  }
  return resolved;
}

/** Env var the built-in jev reranker reads its key from, honouring config. */
export function rerankerKeyEnv(config?: RerankerSettings): string {
  return config?.apiKeyEnv ?? JEV_API_KEY_ENV;
}

/**
 * The configured judgment reranker, or undefined when the config selects
 * `heuristic` or `none`. A passed-in value is used as-is. This constructs a
 * provider, not activation: use `rerankSetup` for search policy and bounds.
 */
export function resolveReranker(config?: RerankerSettings): Reranker | undefined {
  const provider = config?.provider ?? "jev";
  if (typeof provider !== "string") return provider; // custom value, used as-is
  if (provider === "heuristic" || provider === "none") return undefined;
  const factory = Object.hasOwn(RERANKERS, provider) ? RERANKERS[provider] : undefined;
  if (!factory) {
    throw new Error(
      `Unknown reranker "${provider}". Available: ${RERANK_MODES.join(", ")}. Pass a custom Reranker instead.`
    );
  }
  return factory({ model: config?.model, apiKeyEnv: config?.apiKeyEnv });
}

export interface RerankerSelection {
  /** The `rerank` option to search with. */
  rerank: "none" | "heuristic" | "jev";
  /** The judgment reranker to inject when `rerank` is `jev`. */
  reranker?: Reranker;
  /** Why a request could not be honoured as asked; surface it in `warnings`. */
  warning?: string;
}

/**
 * Pick how a search reranks. The one availability policy for the CLI, the
 * MCP server, `brain eval` and every embedding host, so no caller can forget
 * a rule:
 *
 * - `requested` (`--rerank`, MCP `rerank`) wins, then BRAIN_RERANK_MODE when
 *   it names a mode (an invalid value is reported in `warning` and ignored),
 *   then the configured `reranker.provider` (default `jev`).
 * - Judgment ordering requires `config.enabled === true`. Credentials and
 *   mode selection cannot enable it. Preview constructs a request only.
 * - The built-in `jev` needs its key. Without it the configured default
 *   quietly keeps the lifecycle ordering, the rule that keeps a keyless brain
 *   working; an explicit request for `jev` gets the same ordering plus a
 *   warning, never a silent pretence.
 * - A custom Reranker value is used as-is; its key handling is its own.
 * - An unknown requested name throws, for the caller to report as a usage error.
 */
export function selectReranker(
  config?: RerankerSettings,
  requested?: string,
  opts: { preview?: boolean } = {}
): RerankerSelection {
  if (requested !== undefined && !isRerankMode(requested)) {
    throw new Error(`Unknown rerank mode "${requested}". Expected one of: ${RERANK_MODES.join(", ")}.`);
  }
  let warning: string | undefined;
  let name: string | undefined = requested;
  if (name === undefined) {
    const envRaw = readEnvVar("BRAIN_RERANK_MODE");
    const env = envRerankMode();
    if (env) name = env;
    else if (envRaw) warning = `BRAIN_RERANK_MODE="${envRaw}" is not one of ${RERANK_MODES.join(", ")}; ignored`;
  }
  const explicit = name !== undefined;
  const provider = config?.provider ?? "jev";
  if (name === undefined) {
    name = typeof provider === "string" ? provider : "jev";
  }
  if (name === "none" || name === "heuristic") return { rerank: name, warning };
  if (!Object.hasOwn(RERANKERS, name)) {
    // Only a configured name can get here (a requested one was validated
    // above). Search keeps working, and says why it is not reranking.
    return {
      rerank: "heuristic",
      warning: `reranker.provider "${name}" is not one of ${RERANK_MODES.join(", ")}; results are in heuristic order`,
    };
  }
  if (config?.enabled !== true && !opts.preview) {
    return {
      rerank: "heuristic",
      warning: explicit
        ? 'rerank "jev" disabled: reranker.enabled is false; results are in lifecycle order'
        : warning,
    };
  }
  if (!explicit && typeof provider !== "string") return { rerank: "jev", reranker: provider, warning };
  // A dry run builds the request without sending it, so it needs no key.
  if (!opts.preview && !readEnvVar(rerankerKeyEnv(config))) {
    return {
      rerank: "heuristic",
      warning: explicit
        ? `rerank "jev" unavailable: ${rerankerKeyEnv(config)} not set; results are in lifecycle order`
        : warning,
    };
  }
  const configured = config?.provider;
  const reranker =
    typeof configured === "string" && configured === name
      ? resolveReranker(config)
      : resolveReranker({ ...config, provider: name } as RerankerSettings);
  return { rerank: "jev", reranker, warning };
}


/** What a search entry point passes to hybridSearch for reranking. */
export interface RerankSetup {
  rerank: "none" | "heuristic" | "jev";
  deps: {
    rerankerEnabled?: boolean;
    reranker?: Reranker;
    rerankExclude?: (path: string) => boolean;
    rerankTimeoutMs?: number;
    rerankDepth?: number;
    rerankSkipMargin?: number;
  };
  /** Report it in the search's `warnings`. */
  warning?: string;
}

/**
 * `selectReranker` plus the configured bounds, ready to spread into
 * SearchOptions and SearchDeps. Throws on an unknown requested mode.
 */
export function rerankSetup(
  config?: RerankerSettings,
  requested?: string,
  opts: { preview?: boolean } = {}
): RerankSetup {
  const selection = selectReranker(config, requested, opts);
  return {
    rerank: selection.rerank,
    warning: selection.warning,
    deps: selection.reranker
      ? {
          rerankerEnabled: config?.enabled === true,
          reranker: selection.reranker,
          rerankExclude: buildPathMatcher(config?.exclude),
          rerankTimeoutMs: config?.timeoutMs,
          rerankDepth: config?.depth,
          rerankSkipMargin: config?.skipMargin ?? DEFAULT_RERANK_SKIP_MARGIN,
        }
      : {},
  };
}
