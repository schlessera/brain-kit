/**
 * @schlessera/brain-backend-pi — OSS-default agent backend on the upstream pi SDK.
 *
 * The primary export is `createPiBackend(options)`, an AgentBackend for the
 * brain-ui server. Internal building blocks (brain access, curated tools,
 * history normalization) are also exported for testing and reuse.
 */

export { createPiBackend, PI_BACKEND_ID, mapPiEvent } from "./backend.js";
export type {
  BackendLogFn,
  CreatePiBackendOptions,
  PiProfile,
  PiSessionLike,
  PiSessionFactory,
  SessionToolkit,
} from "./backend.js";

export { createPiAuth, hasStoredCredential } from "./auth.js";
export type {
  PiAuth,
  PiAuthProviderStatus,
  PiAuthRuntime,
  PiLoginFlow,
  PiLoginFlowStatus,
  CreatePiAuthOptions,
} from "./auth.js";

export { createBrainAccess } from "./brain-access.js";
export type { BrainAccess } from "./brain-access.js";

export { createBrainTools, TOOL_RISK } from "./tools.js";
export type { RiskClass, BrainToolDeps } from "./tools.js";

export { createTurnContext } from "./turn-context.js";
export type { TurnContext } from "./turn-context.js";

export { listPiSessions, getPiHistory, normalizeMessages } from "./history.js";

// Environment contract (chokepoint: src/config/env.ts). No resolveEnv here:
// the package's only read is data-driven (config-named apiKeyEnv).
export { ENV_VARS, DYNAMIC_ENV_READS, readEnvVar } from "./config/env.js";
export type { EnvVarSpec, DynamicEnvReadSpec } from "./config/env.js";
