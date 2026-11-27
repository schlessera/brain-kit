/**
 * Markers of the legacy machine-managed "Skills index" block formerly written
 * into GEMINI.md and AGENTS.md. Both emitters now migrate it to the installed
 * contract block; existing brains' files still carry these exact strings, so
 * the emitters use them to find a block to migrate.
 */

export const INDEX_START = "<!-- brain-kit:skills-index:start -->";
export const INDEX_END = "<!-- brain-kit:skills-index:end -->";
