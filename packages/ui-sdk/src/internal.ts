/** First-party implementation sharing. No compatibility guarantee; use the same lockstep version. */
export { launchAgentWorker, requireWorkerHost, probeWorkerHost, workerHostBoundary, WorkerHostError, WORKER_SCRATCH } from "./server/worker-launcher.js";
export type { WorkerLaunch, WorkerHostProbe } from "./server/worker-launcher.js";
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
