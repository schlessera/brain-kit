export type {
  AgentBackend,
  BackendBridge,
  BackendActivityEvent,
  BackendCapabilities,
  StartTurnRequest,
  FollowUpRequest,
  PermissionDecision,
  PermissionRequest,
  AskUserResult,
  LocationFix,
} from "./backend.js";
export { BackendBusyError, BackendRequestError } from "./backend.js";

export type { WriteLock } from "./write-lock.js";
export { createWriteLock } from "./write-lock.js";

export type { KeyedLock } from "./keyed-lock.js";
export { createKeyedLock, LockBusyError } from "./keyed-lock.js";

export type { SpeechProvider, SpeechSession } from "./speech.js";
export { defineSpeechProvider } from "./speech.js";

export { BRAIN_UI_SYSTEM_PROMPT_APPEND, buildSystemPromptAppend } from "./system-prompt.js";

export type { TranscriptStore } from "./transcript-store.js";
export { createTranscriptStore } from "./transcript-store.js";

export * from "../protocol.js";
