/**
 * First-party sharing: the default policy tables, and the brain-tool building
 * blocks the packed-package probe (scripts/check-pi-query-package.ts) runs.
 * No compatibility guarantee; use the same lockstep version.
 */
export { DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK, createBrainTools } from "./tools.js";
export { createBrainAccess } from "./brain-access.js";
export { createTurnContext } from "./turn-context.js";
// The trusted host web executor (#3686): ui-server's broker starts one per session.
export { PINNED_WEB_EXTENSION, prepareWebExecutorState, sanitizeWebExecutorConfig, webExecutorCommand } from "./web-executor.js";
export type { PrepareWebExecutorStateOptions, SanitizedWebConfig, WebExecutorState } from "./web-executor.js";
