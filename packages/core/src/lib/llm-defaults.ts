/**
 * Default model identifiers for the built-in LLM providers.
 *
 * These are overridable per provider via config (embeddings.model,
 * completion provider config). This is the one place they are declared: the
 * index schema's default vector width and embedding model and what the
 * embedder requests both read them from here. Upgrade models here, not in
 * call sites.
 */

/** Gemini embedding model (GA). No taskType param — asymmetry via prompt prefixes. */
export const EMBEDDING_MODEL = "gemini-embedding-2";

/** Default embedding output dimensionality. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Fast Gemini generation model — enrichment, briefings, vision descriptions.
 * Typed `string`: the default moves with Gemini releases. */
export const GEMINI_FLASH_MODEL: string = "gemini-3-flash-preview";

/** Fast Claude model for plain completions via the Anthropic API. */
export const CLAUDE_FAST_MODEL = "claude-haiku-4-5-20251001";

/**
 * Pinned Jev model for the built-in reranker. `jev-latest` moves and the
 * measured ordering quality does not transfer across versions, so this stays
 * explicit; bump it deliberately, after re-running `brain eval --rerank jev`.
 */
export const JEV_MODEL = "jev-1.13.0";
