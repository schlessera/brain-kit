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
export {
  execWrapperSpawnOptions,
  killWrapped,
  wrapCommand,
} from "./exec-wrapper.js";

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

export type { SpeechProvider, SpeechSession } from "./speech.js";
export { defineSpeechProvider } from "./speech.js";

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

export type { ReverseGeocodeConfig, ReverseGeocodeResult } from "./reverse-geocode.js";
export { reverseGeocode } from "./reverse-geocode.js";
export { geoConfigSchema } from "@schlessera/brain-geo";
export type { GeoConfig, GeoConfigInput } from "@schlessera/brain-geo";

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
export type {
  ImageMaskHandlerOptions,
  LocationHandlerOptions,
} from "./bridge-tools/index.js";

// The declarative half of the same tools — names, descriptions, input and
// payload schemas, prompt briefs. Server-side importers get both halves from
// this one module; the browser imports the contracts alone.
export * from "../tool-contracts/index.js";




export type { TranscriptStore } from "./transcript-store.js";
export { createTranscriptStore } from "./transcript-store.js";

export * from "../protocol.js";

export { assertVersionRequirements, validateVersionMinimum } from "./version-requirements.js";
export type { BackendVersionRequirements, VersionRequirement, VersionRequirementCheck } from "./version-requirements.js";
