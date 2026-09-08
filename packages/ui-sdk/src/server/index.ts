export type {
  AgentBackend,
  BackendBridge,
  BackendActivityEvent,
  ActivityQuery,
  ActivityQueryResult,
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
export type { SurfaceTools, ExecutionBrief } from "./system-prompt.js";

export {
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_FALLBACK_ON,
  WEB_SEARCH_PROVIDER_KEYS,
  webSearchProvider,
  resolveWebSearchConfigPath,
  hasWebSearchCredential,
  readWebSearchRouting,
  readWebSearchOverride,
  webSearchBrief,
} from "./web-search.js";
export type { WebSearchProviderSpec, WebSearchBrief } from "./web-search.js";

export {
  DEFAULT_CONFIRM_BASH_PATTERNS,
  compileConfirmPatterns,
  bashCommand,
} from "./confirm-patterns.js";

export type { ReverseGeocodeConfig, ReverseGeocodeResult } from "./reverse-geocode.js";
export { reverseGeocode } from "./reverse-geocode.js";

export { rtkAvailable, rtkRewriteCommand, resetRtkProbe } from "./rtk.js";

export { GIT_LOCK_KEY, BRAIN_LOCK_KEY, bashLockKey } from "./lock-keys.js";

export type { SubprocessEnvAudience } from "./subprocess-env.js";
export { SUBPROCESS_ENV, filterSubprocessEnv } from "./subprocess-env.js";

export type { TranscriptStore } from "./transcript-store.js";
export { createTranscriptStore } from "./transcript-store.js";

export * from "../protocol.js";
