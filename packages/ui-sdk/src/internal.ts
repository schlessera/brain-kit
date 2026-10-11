/** First-party implementation sharing. No compatibility guarantee; use the same lockstep version. */
export { launchAgentWorker, launchLimits, requireWorkerHost, WorkerResourceLimitError, probeWorkerHost, workerHostBoundary, WorkerHostError, WORKER_SCRATCH, WORKER_STATE } from "./server/worker-launcher.js";
export type { LaunchedWorker, WorkerLaunch, WorkerHostProbe, WorkerStateHandle } from "./server/worker-launcher.js";
export { ARCHIVING_UPDATE_REASON, archivesDocument, bashCommand } from "./server/confirm-patterns.js";
export { SUBPROCESS_ENV } from "./server/subprocess-env.js";
export { loadedSdkIdentity } from "./server/loaded-sdk.js";
export { applyClassification, observeClassification, planClassification } from "./classification/index.js";
export type { ClassificationAnswers, ClassificationPlan, ClassificationRequest, QuestionObservation } from "./classification/index.js";
export { claudeMaskFilename, claudeReportedMaskPath, piMaskFilename, piReportedMaskPath } from "./server/bridge-tools/index.js";
export { GIT_LOCK_KEY } from "./server/lock-keys.js";
export { VERSION_PROBE_TIMEOUT_MS } from "./server/version-probe.js";
export { WEB_SEARCH_FALLBACK_ON, WEB_SEARCH_PROVIDERS, WEB_SEARCH_PROVIDER_KEYS, hasWebSearchCredential, readWebSearchOverride, readWebSearchRouting, resolveWebSearchConfigPath, webSearchBrief, webSearchProvider } from "./server/web-search.js";
export { canonicalModelId } from "./protocol-helpers.js";
export { execWrapperSpawnOptions } from "./server/exec-wrapper.js";

export { assertScratchMask } from "./server/bridge-tools/mask.js";
export { startInferenceRelay, ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, WORKER_INFERENCE_DIR, WORKER_INFERENCE_SOCKET, MAX_INFERENCE_REQUEST_BYTES } from "./server/inference-relay.js";
export type { InferenceRelay, InferenceRelayEvent, InferenceRelayOptions } from "./server/inference-relay.js";
export type { RestrictedEnvelope, WorkerHostProbeOptions } from "./server/worker-launcher.js";
export { restrictedReadPaths } from "./server/worker-launcher.js";
export { prepareWorkerSandbox, probeHomeOverlay } from "./server/worker-launcher.js";
export type { PrepareWorkerSandboxOptions } from "./server/worker-launcher.js";
export { workerProfile, workerSandboxNote, workerSandboxWarnings, WORKER_AREAS, BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR, WORKER_XDG_DIRS } from "./server/worker-sandbox.js";
export type { WorkerSandbox, WorkerArea, WorkerAreaName, WorkerMount, WorkerHome, WorkerNoteFacts, WorkerNoteLimit, WorkerProfile } from "./server/worker-sandbox.js";
export { createLimitTracker, describeLimitHits, limitFailureMessage, mergeLimitReports, workerLimitsPlan,
  workerLimitsStatus, workerNoteLimits, WORKER_LIMITS_ENV } from "./server/worker-limits.js";
export type { WorkerLimitHit, WorkerLimitReport, WorkerLimitsPlan, WorkerLimitsStatus } from "./server/worker-limits.js";
export { createTurnTemp, createTurnTempPromoter, turnTempRoot, PROMOTED_SCRATCH_DIR, PROMOTION_FILE_MAX_BYTES, PROMOTION_TURN_MAX_BYTES,
  PROMOTION_TURN_MAX_FILES, TURN_TEMP_PREFIX } from "./server/worker-turn-temp.js";
export type { TurnTemp, TurnTempPromoterOptions, TurnTempPromotionRecord } from "./server/worker-turn-temp.js";
export { DEFAULT_WORKER_STATE_BYTES, WORKER_STATE_BUDGET_ENV, WORKER_STATE_BYTES_ENV, WORKER_STATE_PAGE, WorkerStateConfigError, mib,
  parseWorkerStateBytes, resolveWorkerStateLimits, validWorkerStateBytes } from "./server/worker-state-limits.js";
export type { WorkerStateLimits } from "./server/worker-state-limits.js";
