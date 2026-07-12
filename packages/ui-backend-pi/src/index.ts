/**
 * @brainform/ui-backend-pi — OSS-default agent backend on the upstream pi SDK.
 *
 * The primary export is `createPiBackend(options)`, an AgentBackend for the
 * brain-ui server. Internal building blocks (brain access, curated tools,
 * history normalization) are also exported for testing and reuse.
 */

export { createPiBackend, PI_BACKEND_ID, mapPiEvent } from "./backend";
export type { CreatePiBackendOptions, PiProfile } from "./backend";

export { createBrainAccess } from "./brain-access";
export type { BrainAccess } from "./brain-access";

export { createBrainTools, TOOL_RISK } from "./tools";
export type { RiskClass, BrainToolDeps } from "./tools";

export { createTurnContext } from "./turn-context";
export type { TurnContext } from "./turn-context";

export { listPiSessions, getPiHistory, normalizeMessages } from "./history";
