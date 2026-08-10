/**
 * Single source of truth for model identifiers used across the tooling.
 * Upgrade models here, not in call sites.
 */
// GA model (April 2026). The old gemini-embedding-2-preview shuts down
// 2026-08-10. NOTE: the GA model has no taskType parameter — retrieval
// asymmetry is expressed via prompt prefixes in embedder.ts instead.
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 1536;

/** Fast Gemini model for chunk contexts, asset descriptions, and briefings. */
export const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

/** Fast Claude model for briefings via the API. */
export const CLAUDE_FAST_MODEL = "claude-haiku-4-5-20251001";
