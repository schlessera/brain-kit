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
export { prepareWorkerSandbox } from "./server/worker-launcher.js";
export type { PrepareWorkerSandboxOptions } from "./server/worker-launcher.js";
export { workerProfile, workerSandboxNote, workerSandboxWarnings, mountPointsUnder, WORKER_AREAS, BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR, WORKER_XDG_DIRS } from "./server/worker-sandbox.js";
export type { WorkerSandbox, WorkerArea, WorkerAreaName, WorkerMount, WorkerHome, WorkerNoteFacts, WorkerNoteLimit, WorkerProfile } from "./server/worker-sandbox.js";
export { createLimitTracker, describeLimitHits, limitFailureMessage, mergeLimitReports, workerLimitsPlan,
  workerLimitsStatus, workerNoteLimits, WORKER_LIMITS_ENV } from "./server/worker-limits.js";
export type { WorkerLimitHit, WorkerLimitReport, WorkerLimitsPlan, WorkerLimitsStatus } from "./server/worker-limits.js";
export { createTurnTempPressure, createTurnTempPromoter, linkedTurnTempPaths, purgeTurnTemp, turnTempFullMessage, turnTempLimit, turnTempPath,
  turnTempSpace, turnTempUsage, PROMOTED_SCRATCH_DIR, PROMOTION_FILE_MAX_BYTES, PROMOTION_TURN_MAX_BYTES, PROMOTION_TURN_MAX_FILES,
  TURN_TEMP_ROOT, TURN_TEMP_WARN_RATIO } from "./server/worker-turn-temp.js";
export type { TurnTempAccess, TurnTempPromoterOptions, TurnTempPromotionRecord, TurnTempPurgeResult, TurnTempSpace } from "./server/worker-turn-temp.js";
export { handleTurnTemp } from "./server/bridge-tools/turn-temp.js";
export type { TurnTempPurgeRecord } from "./server/bridge-tools/turn-temp.js";
export { DEFAULT_TURN_TEMP_BYTES, DEFAULT_WORKER_STATE_BYTES, TURN_TEMP_BUDGET_ENV, TURN_TEMP_BYTES_ENV, WORKER_STATE_BUDGET_ENV,
  WORKER_STATE_BYTES_ENV, WORKER_STATE_PAGE, WorkerStateConfigError, mib, parseWorkerStateBytes, resolveTurnTempLimits,
  resolveWorkerStateLimits, validWorkerStateBytes } from "./server/worker-state-limits.js";
export type { WorkerStateLimits } from "./server/worker-state-limits.js";
export { workerHostProven, HOST_MASKS, MAINTENANCE_HOME } from "./server/worker-launcher.js";
export type { MaintenanceEnvelope } from "./server/worker-launcher.js";
export { brainGitSync, CREDENTIAL_FREE_ENV, launchMaintenanceWorker, maintenanceLaunch, probeMaintenanceWorker, runMaintenanceWorker, runMaintenanceWorkerSync } from "./server/maintenance-worker.js";
export type { MaintenanceCommand, MaintenanceResult, MaintenanceWorker } from "./server/maintenance-worker.js";
export { createWorkerStartupView } from "./server/worker-startup-view.js";
export type { WorkerStartupView } from "./server/worker-startup-view.js";
export function maintenanceGitEntry(): string { return Bun.resolveSync("./server/maintenance-git-entry", import.meta.dir); }
export { isEnvName, protectedPaths, PROTECTED_ENV_PREFIX, PROTECTED_TIER_A, PROTECTED_TIER_B } from "./server/protected-paths.js";
export { createStateLedger, processStateLedger, WorkerStateError } from "./server/worker-state-budget.js";
export type { Reservation, StateLedger, WorkerStateErrorClass } from "./server/worker-state-budget.js";

export { resolveWorkerProtection } from "./server/worker-protection.js";

export { prepareWorkerOutput } from "./server/worker-output.js";

export { DEFAULT_OUTPUT_STAGING_BYTES, OUTPUT_STAGING_BYTES_ENV, OUTPUT_STAGING_BUDGET_ENV, resolveOutputStagingLimits,
  hostOutputStagingLimits, outputStagingLimit } from "./server/worker-state-limits.js";
