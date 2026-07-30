/**
 * @endoxa/ui-backend-claude — an {@link AgentBackend} implementation backed
 * by the Claude Agent SDK. Session persistence, tool execution, and cost
 * reporting are the SDK's; this package maps its streaming output onto the
 * endoxa chat-UI wire protocol.
 */
export { createClaudeBackend } from "./backend.js";
export type { ClaudeBackendOptions } from "./backend.js";
export { defineProfiles, DEFAULT_PROFILES } from "./profiles.js";
export type { InferenceProfile, InferenceProfileInput } from "./profiles.js";
