/**
 * @endoxa/ui-backend-pi — OSS-default agent backend on the upstream pi SDK.
 *
 * The primary export is `createPiBackend(options)`, an AgentBackend for the
 * brain-ui server. Internal building blocks (brain access, curated tools,
 * history normalization) are also exported for testing and reuse.
 */

export { createPiBackend, PI_BACKEND_ID, mapPiEvent } from "./backend.js";
export type {
  CreatePiBackendOptions,
  PiProfile,
  PiSessionLike,
  PiSessionFactory,
  SessionToolkit,
} from "./backend.js";

export { createBrainAccess } from "./brain-access.js";
export type { BrainAccess } from "./brain-access.js";

export { createBrainTools, TOOL_RISK } from "./tools.js";
export type { RiskClass, BrainToolDeps } from "./tools.js";

export { createTurnContext } from "./turn-context.js";
export type { TurnContext } from "./turn-context.js";

export { listPiSessions, getPiHistory, normalizeMessages } from "./history.js";
