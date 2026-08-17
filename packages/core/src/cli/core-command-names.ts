/**
 * The reserved top-level command words owned by core. A module command word
 * colliding with any of these is a load error (registry) / lint error (module
 * lint). Kept in its own module so both consumers share one source of truth.
 */
export const CORE_COMMAND_NAMES = new Set<string>([
  "search", "context", "read", "list", "briefing", "add", "index", "validate",
  "audit", "process", "archive", "accept-mtime", "maintain", "stats", "graph", "render", "sync",
  "setup", "doctor", "init", "import", "skills", "module", "config", "mcp", "okf",
]);
