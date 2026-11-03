/**
 * Standalone Apify for the `brain` CLI and core MCP server (#3162), over the
 * shared operations in `@schlessera/brain-common/internal/apify`.
 * First-party implementation sharing only: no compatibility guarantee, same
 * lockstep version (docs/decisions/public-export-boundary.md).
 */
export * from "./lib/apify/standalone.js";
export * from "./lib/apify/site-permission.js";
