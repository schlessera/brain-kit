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
  run(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<string>;
  runStreaming?(
    prompt: string,
    opts: {
      cwd: string;
      onEvent: (e: { kind: "tool" | "text"; label: string }) => void;
    }
  ): Promise<string>;
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

/**
 * Turns a self-contained HTML document into page bytes. Implemented by
 * `@schlessera/brain-render-puppeteer` (headless Chrome, network-denied by
 * default); absent when that optional package is not installed, in which case
 * `brain render` still writes HTML and says what to install for PDF/PNG.
 */
export interface DocumentRenderer {
  renderPdf(opts: { html: string; width?: number }): Promise<Buffer>;
  renderPng(opts: { html: string; width?: number }): Promise<Buffer>;
  shutdown(): Promise<void>;
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
 * Emits skills into an agent's native discovery location. The canonical home
 * is `.agents/skills/` (discovered natively by the pi family); emitters cover
 * agents that need another layout (claude → .claude/skills symlinks,
 * codex → .codex/prompts, …).
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface SkillEmitter {
  agent: string;
  emit(
    skills: SkillManifest[],
    repoRoot: string
  ): { written: string[]; removed: string[] };
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
