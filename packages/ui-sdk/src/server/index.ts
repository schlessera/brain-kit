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

export type {
  BackendLogFn,
  BackendProfileDeclaration,
  BackendProfileError,
  BackendProfileParseResult,
  BackendProfileSchemaContext,
  BackendProfileSchema,
  BackendSettingsReaders,
  BackendSettingsHooks,
  BackendModelSourceState,
  BackendModelSource,
  BackendModuleContext,
  ResolvedBackendModule,
  BackendModuleResolution,
  BackendModule,
} from "./backend-module.js";
export { BackendProfileConfigError, defineBackendModule } from "./backend-module.js";

export type { KillableProcess } from "./exec-wrapper.js";
export {
  EXEC_WRAPPER_ENV,
  execWrapperSpawnOptions,
  killWrapped,
  validateExecWrapper,
  wrapCommand,
} from "./exec-wrapper.js";

export type { WriteLock } from "./write-lock.js";
export { createWriteLock } from "./write-lock.js";

export type { KeyedLock } from "./keyed-lock.js";
export { createKeyedLock, LockBusyError } from "./keyed-lock.js";

export {
  OSM_ATTRIBUTION,
  clipLine,
  closedRings,
  detailFor,
  fetchCoastline,
  prepare,
  prepareLand,
  simplify,
  toleranceMetres,
} from "./coastline.js";
export type { BBox, Coord, CoastlineConfig, CoastlineRequest, CoastlineResult, FetchLike, MapDetail } from "./coastline.js";

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

export type {
  ToolPermissionDecisionInput,
  ToolPermissionApproval,
  CreateToolPermissionRequestInput,
} from "./permission-gate.js";
export {
  decideToolPermission,
  createToolPermissionRequest,
  requestToolPermission,
} from "./permission-gate.js";

export type { ReverseGeocodeConfig, ReverseGeocodeResult } from "./reverse-geocode.js";
export { reverseGeocode } from "./reverse-geocode.js";

export * from "./bridge-tools/index.js";

// The declarative half of the same tools — names, descriptions, input and
// payload schemas, prompt briefs. Server-side importers get both halves from
// this one module; the browser imports the contracts alone.
export * from "../tool-contracts/index.js";
export * from "../classification/index.js";

export { rtkAvailable, rtkRewriteCommand, resetRtkProbe } from "./rtk.js";

export { GIT_LOCK_KEY, BRAIN_LOCK_KEY, bashLockKey } from "./lock-keys.js";

export type { SubprocessEnvAudience } from "./subprocess-env.js";
export {
  SUBPROCESS_ENV,
  filterSubprocessEnv,
  parseSubprocessEnvExtra,
} from "./subprocess-env.js";

export type { TranscriptStore } from "./transcript-store.js";
export { createTranscriptStore } from "./transcript-store.js";

export * from "../protocol.js";
