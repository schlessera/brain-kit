/**
 * Extension seams. Each seam carries its own `@experimental` tag until 1.0;
 * docs/extending/README.md lists them.
 *
 * The meta-mechanism: a typed interface here → config accepts a built-in name
 * (string) OR a passed-in implementation (value) → optionally shared as an npm
 * package. No plugin loader, no DI container, no runtime discovery.
 *
 * A seam exists only where a second implementation is plausible within a
 * year. Everything else stays concrete code.
 */

/** A piece of multimodal content passed to a completion request. */
export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; data: Uint8Array; mimeType: string }
  | { kind: "pdf"; data: Uint8Array };

/**
 * Plain (non-agentic) LLM completion. Used for enrichment (chunk contexts,
 * asset descriptions), note processing, and briefings.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface CompletionProvider {
  id: string;
  capabilities: { vision: boolean };
  complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
  }): Promise<string>;
}

/**
 * Agentic run inside a repo — shells out to a coding agent CLI (claude, pi,
 * codex, gemini, or any custom value). Used by skill-invoking flows.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface AgentRunner {
  id: string;
  capabilities: { streaming: boolean; skills: boolean };
  run(
    prompt: string,
    opts: { cwd: string; timeoutMs?: number; onRuntime?: (runtime: AgentRuntime) => void }
  ): Promise<string>;
  runStreaming?(
    prompt: string,
    opts: {
      cwd: string;
      onEvent: (e: { kind: "tool" | "text"; label: string }) => void;
      onRuntime?: (runtime: AgentRuntime) => void;
    }
  ): Promise<string>;
}

/**
 * What an agent run said about the runtime that executed it (#290), passed to
 * `onRuntime` as soon as the runtime reports it — before the run can still
 * fail, so a caller keeps it when the run then throws. Observed, never probed:
 * a runner that cannot tell does not call it, and `version` is absent when the
 * runtime named itself but not its version.
 *
 * @experimental Part of the `AgentRunner` seam; may change before 1.0.
 */
export interface AgentRuntime {
  /** e.g. `claude-code`, the name chat records for the same binary. */
  name: string;
  version?: string;
}

/**
 * Text (and optionally multimodal) embeddings. Enrichment/generation concerns
 * live in enrichment.ts on top of CompletionProvider — NOT here.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface EmbeddingProvider {
  /** Stable identity, e.g. "gemini:gemini-embedding-2". Changing it forces a re-embed. */
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Query cancellation is optional; search also bounds providers that ignore it. */
  embedQuery(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
  /** Optional multimodal support; absent → core embeds the text description instead. */
  embedImage?(buffer: Uint8Array, mimeType: string, description: string): Promise<Float32Array>;
  embedPdf?(buffer: Uint8Array, description: string): Promise<Float32Array>;
}

/** The retrieval lane a search ran in; a reranker declares which it serves. */
export type SearchMode = "fts" | "vector" | "hybrid";

/**
 * What a reranker judges. Deliberately not a SearchResult: the same reranker
 * orders a brain document, a record from another source, or the union of
 * several sources fanned out behind one query. `excerpt` is the passage the
 * retriever matched — the one query-conditioned field, and the one that
 * carries the signal; unconditioned text (document heads, bodies) measured
 * worse.
 *
 * @experimental Part of the `Reranker` seam; may change before 1.0.
 */
export interface RerankCandidate {
  /** Stable within its source: a brain path, a record id. */
  id: string;
  /**
   * Where the candidate came from ("brain", "calendar", …). A fan-out sets it
   * so a result traces back to its origin; `source` + `id` is the identity a
   * reranker must preserve. Rerankers return the caller's own objects by
   * reference, never copies, so anything else the caller attached survives.
   */
  source?: string;
  title: string;
  type?: string;
  tags?: string;
  summary?: string | null;
  excerpt?: string;
  /**
   * Facts about the candidate the judgment may weigh. A brain passes its
   * lifecycle fields — `status`, `relevance`, `updated` — so a draft or a
   * historical document is judged as one, rather than re-sorted afterwards by
   * fixed multipliers (measured: as evidence they helped the hybrid lane; as
   * multipliers after the judgment they undid it).
   */
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  /** Retrieval score, for rerankers that nudge instead of replace. */
  score?: number;
}

/** @experimental Part of the `Reranker` seam; may change before 1.0. */
export interface RerankRequest<C extends RerankCandidate = RerankCandidate> {
  query: string;
  /** Candidates in retrieval order. The reranker returns the same set, reordered. */
  candidates: readonly C[];
  /** The lane the candidates came from; absent for a cross-source union. */
  mode?: SearchMode;
  /** Fires when the caller's deadline passes; forward it to any HTTP call. */
  signal?: AbortSignal;
}

/**
 * One reranked candidate with the reranker's own score (a probability for jev).
 *
 * @experimental Part of the `Reranker` seam; may change before 1.0.
 */
export interface Ranked<C extends RerankCandidate = RerankCandidate> {
  item: C;
  score: number;
}

/**
 * Orders one query's candidates by relevance judgment. Inside hybridSearch it
 * runs after fusion and before truncation, and the lifecycle factors (draft,
 * historical, recency, `generated_from`) and `supersedes` demotion still apply
 * after it — a reranker decides what answers the query, the brain's metadata
 * then nudges that order. A fan-out over several sources runs it once over the
 * union (per-source reranking then fusing is not comparable: a Choice's
 * probabilities normalise within one call).
 *
 * Contract: return every candidate exactly once, by reference. Throwing (or
 * missing the caller's deadline) is a degraded mode, not a failure — search
 * keeps the retrieval order and reports it in `warnings`.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface Reranker {
  /** Stable identity including the pinned model, e.g. "jev:jev-1.13.0". */
  id: string;
  capabilities: {
    /** Lanes this reranker serves; search skips it on the others. */
    modes: readonly SearchMode[];
    /**
     * True when candidates leave the machine. Callers then withhold the paths
     * matched by `reranker.exclude` and re-merge them at their retrieval rank,
     * so a network reranker never sees them.
     */
    network: boolean;
  };
  rerank<C extends RerankCandidate>(req: RerankRequest<C>): Promise<Ranked<C>[]>;
  /**
   * The exact request `rerank` would transmit, for privacy inspection
   * (`brain search --rerank-dry-run`). Must not send anything.
   */
  preview?<C extends RerankCandidate>(req: Omit<RerankRequest<C>, "signal">): unknown;
}

/** A skill as discovered from a skills/ directory. */
export interface SkillManifest {
  /** Directory name == skill name. */
  name: string;
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  /** Origin layer, for precedence reporting. */
  source: "core" | "module" | "local";
  /** Raw frontmatter for emitters that need extra keys. */
  frontmatter: Record<string, unknown>;
}

/**
 * Emits skills and agent instructions into the locations an agent reads. The
 * canonical skills home is `.agents/skills/`, discovered natively by Codex
 * and Gemini. Claude and pi use symlinks in `.claude/skills/` and `.pi/skills/`.
 * Codex and Gemini embed the installed agent contract in AGENTS.md and
 * GEMINI.md, respectively.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface SkillEmitter {
  agent: string;
  emit(
    skills: SkillManifest[],
    repoRoot: string
  ): {
    written: string[];
    removed: string[];
    /** Things the emitter deliberately left alone and the user should know about. */
    warnings?: string[];
  };
}

// ---------------------------------------------------------------------------
// Typed authoring helpers — identity functions that give contributors
// inference + excess-property checking without importing the interface.
// ---------------------------------------------------------------------------

export function defineEmbeddingProvider(provider: EmbeddingProvider): EmbeddingProvider {
  return provider;
}

export function defineCompletionProvider(provider: CompletionProvider): CompletionProvider {
  return provider;
}

export function defineAgentRunner(runner: AgentRunner): AgentRunner {
  return runner;
}

export function defineSkillEmitter(emitter: SkillEmitter): SkillEmitter {
  return emitter;
}

export function defineReranker(reranker: Reranker): Reranker {
  return reranker;
}
