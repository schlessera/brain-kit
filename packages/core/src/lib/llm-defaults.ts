/**
 * Default model identifiers for the built-in LLM providers.
 *
 * These are overridable per provider via config (embeddings.model,
 * completion provider config). Kept in their own module so the seam layer has
 * a stable import even before a fuller models.ts lands; if models.ts is added
 * later it can re-export these to keep a single source of truth.
 */

/** Gemini embedding model (GA). No taskType param — asymmetry via prompt prefixes. */
export const EMBEDDING_MODEL = "gemini-embedding-2";

/** Default embedding output dimensionality. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Fast Gemini generation model — enrichment, briefings, vision descriptions. */
export const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

/** Fast Claude model for plain completions via the Anthropic API. */
export const CLAUDE_FAST_MODEL = "claude-haiku-4-5-20251001";

/**
 * Pinned Jev model for the built-in reranker. `jev-latest` moves and the
 * measured ordering quality does not transfer across versions, so this stays
 * explicit; bump it deliberately, after re-running `brain eval --rerank jev`.
 */
export const JEV_MODEL = "jev-1.13.0";
