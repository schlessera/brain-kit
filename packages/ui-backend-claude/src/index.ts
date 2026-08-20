/**
 * @schlessera/brain-backend-claude — an {@link AgentBackend} implementation backed
 * by the Claude Agent SDK. Session persistence, tool execution, and cost
 * reporting are the SDK's; this package maps its streaming output onto the
 * brain-kit chat-UI wire protocol.
 */
export { createClaudeBackend, DEFAULT_CONFIRM_BASH_PATTERNS } from "./backend.js";
export type { ClaudeBackendOptions } from "./backend.js";
export { defineProfiles, DEFAULT_PROFILES } from "./profiles.js";
export type { InferenceProfile, InferenceProfileInput } from "./profiles.js";
export {
  discoverAnthropicModels,
  createModelSource,
  canonicalModelId,
  modelCachePath,
} from "./model-discovery.js";
export type {
  ModelSource,
  ModelSourceOptions,
  ModelSourceState,
  DiscoverOptions,
  DiscoverResult,
  AliasChecks,
} from "./model-discovery.js";

// Environment contract (chokepoint: src/config/env.ts). envSnapshot stays
// internal — the whole-environment passthrough is not for consumers.
export { ENV_VARS, DYNAMIC_ENV_READS, resolveEnv, readEnvVar } from "./config/env.js";
export type { EnvVarSpec, DynamicEnvReadSpec, ClaudeBackendEnv } from "./config/env.js";
