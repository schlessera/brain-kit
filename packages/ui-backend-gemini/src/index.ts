/**
 * @brainform/ui-backend-gemini — AgentBackend on Google's @google/genai SDK.
 *
 * The primary export is createGeminiBackend(options). Internal building blocks
 * are also exported for testing and reuse.
 */

export { createGeminiBackend, GEMINI_BACKEND_ID } from "./backend";
export type {
  CreateGeminiBackendOptions,
  GeminiProfile,
} from "./backend";

export { createBrainAccess } from "./brain-access";
export type { BrainAccess } from "./brain-access";

export {
  callTool,
  GEMINI_FUNCTION_DECLARATIONS,
  TOOL_RISK,
} from "./tools";
export type {
  GeminiFunctionDeclaration,
  GeminiToolContext,
  GeminiToolResult,
  RiskClass,
} from "./tools";

export { createTurnContext } from "./turn-context";
export type { TurnContext } from "./turn-context";

export {
  createGeminiSessionStore,
  createStoredSession,
} from "./session-store";
export type {
  CreateStoredSessionOptions,
  GeminiSessionStore,
  StoredSession,
} from "./session-store";
