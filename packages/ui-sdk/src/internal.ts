/** First-party implementation sharing. No compatibility guarantee; use the same lockstep version. */
export { BRAIN_INTERACTION_GUIDANCE, projectConversationGuidance, conversationOrientation, ORIENTATION_MAX_BYTES } from "./server/interaction-guidance.js";
export { prepareRecoveredWorkerFiles, recoveredWorkerFile, recoveredWorkerFiles } from "./server/worker-identity-reader.js";
export { workerCleanupUnconfirmed, workerIdentityHelper, reportStrandedWorkerCleanup } from "./server/worker-identity.js";
export { verifiedWorkerIdentity } from "./server/worker-launcher.js";
export { launchAgentWorker, launchAgentWorkerAsync, launchLimits, requireWorkerHost, requireWorkerHostAsync, WorkerResourceLimitError, probeWorkerHost, probeWorkerHostAsync, workerHostBoundary, WorkerHostError, WORKER_SCRATCH, WORKER_STATE } from "./server/worker-launcher.js";
export { WORKER_EMPTY_HOME } from "./server/worker-xdg.js";
export type { LaunchedWorker, WorkerLaunch, WorkerHostProbe, WorkerStateHandle } from "./server/worker-launcher.js";
export { archivesDocument, bashCommand } from "./server/confirm-patterns.js";
export { SUBPROCESS_ENV, HOST_ONLY_SECRET_ENV, HOST_GIT_CREDENTIAL_ENV, AGENT_INFERENCE_CREDENTIAL_ENV, WORKER_PROVIDER_CREDENTIAL_ENV, workerProviderCredentials } from "./server/subprocess-env.js";
export { loadedSdkIdentity } from "./server/loaded-sdk.js";
export { applyClassification, observeClassification, planClassification } from "./classification/index.js";
export type { ClassificationAnswers, ClassificationPlan, ClassificationRequest, QuestionObservation } from "./classification/index.js";
export { claudeMaskFilename, claudeReportedMaskPath, piMaskFilename, piReportedMaskPath } from "./server/bridge-tools/index.js";
export { GIT_LOCK_KEY } from "./server/lock-keys.js";
export { VERSION_PROBE_TIMEOUT_MS } from "./server/version-probe.js";
export type { WebToolUnavailableFeature } from "./server/web-search.js";
export { WEB_SEARCH_FALLBACK_ON, WEB_SEARCH_PROVIDERS, WEB_SEARCH_PROVIDER_KEYS, WEB_TOOL_UNAVAILABLE_FEATURES, hasWebSearchCredential, webSearchKeySource, readWebSearchOverride, readWebSearchRouting, resolveWebSearchConfigPath, webSearchBrief, webSearchProvider } from "./server/web-search.js";
export { canonicalModelId } from "./protocol-helpers.js";
export { execWrapperSpawnOptions, workerExecHelpers } from "./server/exec-wrapper.js";

export { assertScratchMask, assertScratchMaskAsync } from "./server/bridge-tools/mask.js";
export { startInferenceRelay, ANTHROPIC_INFERENCE_ROUTES, INFERENCE_PLACEHOLDER, WORKER_INFERENCE_SOCKET } from "./server/inference-relay.js";
export type { InferenceRelay, InferenceRelayEvent } from "./server/inference-relay.js";
export { startEgressProxy, WORKER_EGRESS_DIR, WORKER_EGRESS_TRANSPORT_ENV } from "./server/egress-proxy.js";
export { startProviderRelay, parseCliProviderOrigins, relayedProviderKeys, heldCustomProviderKeys, PROVIDER_RELAY_KEYS_NAME, providerUsage, FIRST_PARTY_PROVIDER_RECIPIENTS, PROVIDER_RELAY_SOCKET_NAME, WORKER_PROVIDER_RELAY_SOCKET, MAX_PROVIDER_REQUEST_BYTES, type ProviderRelay, type ProviderRelayOptions, type ProviderRelayReceipt, type ProviderRelayRefusal, type ProviderUsage, type ProviderOperation } from "./server/provider-relay.js";
export { hostProviderCredential, hostComputeCredential } from "./config/env.js";
export type { EgressRecord, EgressRefusal } from "./server/egress-proxy.js";
export { restrictedReadPaths } from "./server/worker-launcher.js";
export { prepareWorkerSandbox, prepareWorkerSandboxAsync } from "./server/worker-launcher.js";
export { workerProfile, workerSandboxNote, workerSandboxWarnings, mountPointsUnder, BRAIN_SCRATCH_DIR, BRAIN_WORKSPACES_DIR, WORKER_XDG_DIRS } from "./server/worker-sandbox.js";
export type { WorkerSandbox, WorkerNoteFacts, WorkerNoteLimit, WorkerProviderMasks, WorkerDataTree } from "./server/worker-sandbox.js";
export { createLimitTracker, limitFailureMessage, mergeLimitReports, workerLimitsPlan, workerLimitsStatus, workerNoteLimits } from "./server/worker-limits.js";
export type { WorkerLimitReport, WorkerLimitsPlan, WorkerLimitsStatus } from "./server/worker-limits.js";
export { createTurnTempPressure, createTurnTempPromoter, turnTempLimit, turnTempSpace, TURN_TEMP_ROOT } from "./server/worker-turn-temp.js";
export type { TurnTempAccess, TurnTempPromotionRecord } from "./server/worker-turn-temp.js";
export { handleTurnTemp } from "./server/bridge-tools/turn-temp.js";
export type { TurnTempPurgeRecord } from "./server/bridge-tools/turn-temp.js";
export { DEFAULT_TURN_TEMP_BYTES, WORKER_STATE_BYTES_ENV, mib, parseWorkerStateBytes, resolveTurnTempLimits, resolveWorkerStateLimits } from "./server/worker-state-limits.js";
export type { WorkerStateLimits } from "./server/worker-state-limits.js";
export { resolveMaintenanceTempLimits } from "./server/worker-state-limits.js";
export { hostMaintenanceTempLimits } from "./server/maintenance-temp-limits.js";
export { workerHostProven, HOST_MASKS, MAINTENANCE_HOME, WORKER_PROVIDER_RELAY_DIR } from "./server/worker-launcher.js";
export { CREDENTIAL_FREE_ENV, prepareMaintenanceGitInput, prepareMaintenanceWorker, launchMaintenanceWorker, launchMaintenanceWorkerAsync, maintenanceLaunch, probeNativeMaintenanceWorker, runMaintenanceWorker, runMaintenanceWorkerSync } from "./server/maintenance-worker.js";
export type { MaintenanceHost, MaintenanceCommand, MaintenanceResult } from "./server/maintenance-worker.js";
export { MaintenanceTempBusyError, reserveMaintenanceTemp, type MaintenanceTempKind } from "./server/maintenance-temp-budget.js";
export { prepareNativeWorkerStartupView, retainWorkerStartupView, nativeWorkerStartupInput, isManagedWorkerStartupView, assertManagedTurnStartupView, UNMANAGED_TURN_STORAGE, hasManagedNativeStorage } from "./server/worker-startup-view.js";
export type { WorkerStartupView } from "./server/worker-startup-view.js";
export function maintenanceGitEntry(): string { return Bun.resolveSync("./server/maintenance-git-entry", import.meta.dir); }
export { isEnvName, protectedPaths, PROTECTED_ENV_PREFIX, PROTECTED_TIER_A, PROTECTED_TIER_B } from "./server/protected-paths.js";
export { createStateLedger, processStateLedger, WorkerStateError } from "./server/worker-state-budget.js";
export type { Reservation, StateLedger, WorkerStateErrorClass } from "./server/worker-state-budget.js";

export { envMaskedPaths, PROVIDER_CACHE_DIR, PROVIDER_CACHE_FILES, resolveWorkerProtection } from "./server/worker-protection.js";

export { prepareWorkerOutput } from "./server/worker-output.js";

export { hostOutputStagingLimits, outputStagingLimit } from "./server/worker-state-limits.js";
export { compileWorkerCommandPolicy, denyWorkerCommand, requestPolicyPermission,
  workerCommandPolicyNote } from "./server/command-policy.js";
export type { CompiledWorkerCommandPolicy, WorkerCommandPolicy } from "./server/command-policy.js";

export { prepareOutwardPlan, commitOutwardPlan, observeOutwardPlan, OUTWARD_VOICE_REFUSAL, workerOutwardNote } from "./server/outward-policy.js";
export type { OutwardPlan } from "./server/outward-policy.js";
export { sameSafetyAdmission, safetyAdmissionRefusal, STALE_SAFETY_ADMISSION } from "./server/admission-safety.js";
export type { AdmissionSafety, AdmissionSafetySnapshot } from "./server/admission-safety.js";
export { NativeFileVersions, nativeFileVersion } from "./server/native-file-versions.js";
export { createWorkerFileObserver } from "./server/worker-file-observer.js";
export type { ObservedWorkerFile } from "./server/worker-file-observer.js";
export { WORKER_AREA_ROOT, WORKER_DATA_ROOT, WORKER_REFERENCE_ROOT, WORKER_WORKTREE_ROOT } from "./server/worker-sandbox.js";
export { parseNativeBrainDelta } from "./server/native-brain-delta.js";
export type { NativeBrainDeltaCandidate } from "./server/native-brain-delta.js";

export { prepareNativeWorkerOutput, type PreparedWorkerOutput, type WorkerOutputStorage } from "./server/worker-native-output.js";

export { createNativeBrainManagerClient } from "./server/native-brain-manager-client.js";
export { NATIVE_MANAGER_OPERATION_TIMEOUT_MS, NATIVE_MANAGER_MAX_DELTA_BYTES, NativeBrainManagerError } from "./server/native-brain-manager-protocol.js";
export type { NativePoolRecord, NativePoolStatus, NativePoolState, NativePoolCheckpoint, NativePoolAccess, NativePoolCreatePurpose } from "./server/native-brain-manager-protocol.js";
// Runtime-neutral: the pool module reaches `bun:sqlite`, which this entry's Node build must never load.
export { REFERENCE_POOL_CHECKPOINT_BYTES } from "./server/native-brain-manager-protocol.js";

export { RTK_WORKER_ENV } from "./server/rtk.js";
export { sessionPromptContext } from "./server/session-prompt-context.js";
export type { SessionPromptFacts } from "./server/session-prompt-context.js";

export { describeClient } from "./server/system-prompt.js";

export { sessionReplay } from "./server/session-replay.js";

export { promptPrefixFingerprint } from "./server/prompt-fingerprint.js";

export { rewriteWorkerRtk } from "./server/worker-rtk.js";
export { acquireHostCredentialExclusion, HostCredentialExclusionError, type HostCredentialDomain } from "./server/credential-exclusion.js";

export { combineRemovalOutcomes, createSessionRetirement, ownedNames, removeMetadataFile, removeOwnedArtifact } from "./server/native-history-removal.js";
export type { RemovalRun, SessionRetirement, SessionRetirementOptions } from "./server/native-history-removal.js";
export { sessionReplayLocation } from "./server/session-replay.js";
export { sessionPromptContextLocation } from "./server/session-prompt-context.js";
export { nativeObservationIdentity } from "./server/native-observation-storage.js";

export { createCleanupReconciler, processCleanupReconciler, CLEANUP_RETRY_ATTEMPTS, CLEANUP_RETRY_BASE_MS, CLEANUP_RETRY_MAX_MS } from "./server/cleanup-reconciler.js";
export type { CleanupNotice, CleanupReconciler, CleanupReconcilerOptions, RetainedCleanup } from "./server/cleanup-reconciler.js";
