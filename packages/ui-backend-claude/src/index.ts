/**
 * @brainform/ui-backend-claude — an {@link AgentBackend} implementation backed
 * by the Claude Agent SDK. Session persistence, tool execution, and cost
 * reporting are the SDK's; this package maps its streaming output onto the
 * brainform chat-UI wire protocol.
 */
export { createClaudeBackend } from "./backend";
export type { ClaudeBackendOptions } from "./backend";
export { defineProfiles, DEFAULT_PROFILES } from "./profiles";
export type { InferenceProfile, InferenceProfileInput } from "./profiles";
