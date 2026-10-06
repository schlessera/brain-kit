/**
 * @schlessera/brain-backend-pi — OSS-default agent backend on the upstream pi SDK.
 *
 * The primary export is `createPiBackend(options)`, an AgentBackend for the
 * brain-ui server, and `backendModule`, its descriptor. Its building blocks
 * (brain access, curated tools, history normalization) are not exported.
 */

export { createPiBackend } from "./backend.js";
export { backendModule } from "./module.js";
export type {
  BackendLogFn,
  CreatePiBackendOptions,
  PiProfile,
} from "./backend.js";

// Environment contract (chokepoint: src/config/env.ts).
export { ENV_VARS, DYNAMIC_ENV_READS, readEnvVar, resolveEnv } from "./config/env.js";
export type { EnvVarSpec, DynamicEnvReadSpec, PiBackendEnv } from "./config/env.js";
