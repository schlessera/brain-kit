export type {
  AgentBackend,
  BackendBridge,
  BackendActivityEvent,
  ActivityQuery,
  ActivityQueryResult,
  BackendCapabilities,
  StartTurnRequest,
  AutonomousTurnOptions,
  CompletedAutonomousToolCall,
  FollowUpRequest,
  PermissionDecision,
  PermissionRequest,
  AskUserResult,
  AskUserListResult,
  AskUserRankResult,
  AskUserFormResult,
  LocationFix,
  SubscriptionAuthAction,
  UnavailableProfile,
} from "./backend.js";
export {
  BackendBusyError,
  BackendRequestError,
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  SUBSCRIPTION_RELOGIN_PROCEDURE,
  assertTurnPosture,
  isCompletedAutonomousToolCall,
  subscriptionAuthAction,
} from "./backend.js";

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
  BackendRuntimeReport,
} from "./backend-module.js";
export { BackendProfileConfigError, defineBackendModule } from "./backend-module.js";

export type { ExecWrapperConfig, KillableProcess, WrappedKillOptions } from "./exec-wrapper.js";
export { killWrapped } from "./exec-wrapper.js";

export { probeVersionCommand } from "./version-probe.js";
export type { VersionProbeOptions, VersionProbeResult } from "./version-probe.js";

export type { WriteLock } from "./write-lock.js";
export { createWriteLock } from "./write-lock.js";

export type { KeyedLock, KeyedLockAcquireOptions } from "./keyed-lock.js";
export { createKeyedLock, LockBusyError } from "./keyed-lock.js";

export {
  OSM_ATTRIBUTION,
  clipLine,
  closeAgainstViewport,
  closedRings,
  detailFor,
  fetchCoastline,
  prepare,
  prepareLand,
  signedArea,
  simplify,
  stitch,
  toleranceMetres,
} from "./coastline.js";
export type {
  BBox,
  Coord,
  CoastlineConfig,
  CoastlineRequest,
  CoastlineResult,
  FetchLike,
  LandOptions,
  MapDetail,
} from "./coastline.js";

export type { SpeechProvider, SpeechSession, SavedAudioTranscription } from "./speech.js";
export { defineSpeechProvider, SpeechTranscriptionError } from "./speech.js";

export type {
  ConversationResync,
  ConversationScope,
  ConversationWorkRef,
  ConversationWorkResult,
  LiveConversationAudioChunk,
  LiveConversationEvent,
  LiveConversationOpenOptions,
  LiveConversationProvider,
  LiveConversationSession,
} from "./conversation.js";
export {
  assertLiveConversationProvider,
  assertLiveConversationSession,
  defineLiveConversationProvider,
  parseLiveConversationEvent,
} from "./conversation.js";

export { BRAIN_UI_SYSTEM_PROMPT_APPEND, buildSystemPromptAppend } from "./system-prompt.js";
export type { SurfaceTools, ExecutionBrief } from "./system-prompt.js";

export type { WebSearchBrief } from "./web-search.js";

export type {
  CompiledConfirmPattern,
  ConfirmPattern,
  ConfirmPatternSource,
} from "./confirm-patterns.js";
export { compileConfirmPatterns } from "./confirm-patterns.js";

export type {
  ToolPermissionDecisionInput,
  ToolPermissionApproval,
  CreateToolPermissionRequestInput,
  EditedApprovalCheckInput,
  RequestToolPermissionOptions,
} from "./permission-gate.js";
export {
  checkEditedApproval,
  decideToolPermission,
  createToolPermissionRequest,
  requestToolPermission,
} from "./permission-gate.js";

// The shared backend toolkit (#1399): every helper both shipped backends use
// to give the host the same behavior and security posture. Each declaration
// is tagged `@experimental` until 1.0; see
// docs/decisions/backend-authoring-toolkit.md for the inventory.
export {
  handleAskUser,
  handleAskUserForm,
  handleAskUserList,
  handleAskUserRank,
  handleGetCurrentLocation,
  handleQueryActivity,
  handleRequestImageMask,
  handleShowBlock,
} from "./bridge-tools/index.js";
export type { ImageMaskHandlerOptions, LocationHandlerOptions } from "./bridge-tools/index.js";
export { BRIDGE_TOOL_POSTURE } from "../tool-contracts/bridge.js";
export { EXEC_KILLER_ENV, EXEC_WRAPPER_ENV, validateExecWrapper, wrapCommand } from "./exec-wrapper.js";
export type { SubprocessEnvAudience } from "./subprocess-env.js";
export { filterSubprocessEnv, parseSubprocessEnvExtra } from "./subprocess-env.js";
export { BRAIN_LOCK_KEY, bashLockKey } from "./lock-keys.js";
export { DEFAULT_CONFIRM_BASH_PATTERNS } from "./confirm-patterns.js";
export { describeRetry, resolveThinkingLevel } from "../protocol-helpers.js";
export { assertLoadedSdk } from "./loaded-sdk.js";
export { rtkRewriteCommand } from "./rtk.js";

export type { ReverseGeocodeConfig, ReverseGeocodeResult } from "./reverse-geocode.js";
export { reverseGeocode } from "./reverse-geocode.js";
export { geoConfigSchema } from "@schlessera/brain-geo";
export type { GeoConfig, GeoConfigInput } from "@schlessera/brain-geo";


// The declarative half of the same tools — names, descriptions, input and
// payload schemas, prompt briefs. Server-side importers get both halves from
// this one module; the browser imports the contracts alone.
export * from "../tool-contracts/index.js";




export type { TranscriptStore } from "./transcript-store.js";
export { createTranscriptStore } from "./transcript-store.js";

export * from "../protocol.js";

export { assertVersionRequirements, validateVersionMinimum } from "./version-requirements.js";
export type { BackendVersionRequirements, VersionRequirement, VersionRequirementCheck } from "./version-requirements.js";

export { brainApplicationInput, BRAIN_APPLICATION_MAX_BYTES } from "./brain-application.js";
export type { BrainApplicationInput, BrainApplicationOperation, BrainApplicationResult, BrainApplicationPolicy } from "./brain-application.js";
export { BRAIN_APPLICATION_TOOLS, BRAIN_APPLICATION_DESCRIPTIONS } from "./brain-application.js";

export { BRAIN_MASK_MAX_BYTES, type BrainMaskInput } from "./brain-mask.js";
