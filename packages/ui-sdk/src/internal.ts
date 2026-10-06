/** First-party implementation sharing. No compatibility guarantee; use the same lockstep version. */
export { DEFAULT_CONFIRM_BASH_PATTERNS, ARCHIVING_UPDATE_REASON, archivesDocument, bashCommand } from "./server/confirm-patterns.js";
export type { SubprocessEnvAudience } from "./server/subprocess-env.js";
export { SUBPROCESS_ENV, filterSubprocessEnv, parseSubprocessEnvExtra } from "./server/subprocess-env.js";
export { assertLoadedSdk, loadedSdkIdentity } from "./server/loaded-sdk.js";
export { applyClassification, observeClassification, planClassification } from "./classification/index.js";
export type { ClassificationAnswers, ClassificationPlan, ClassificationRequest, QuestionObservation } from "./classification/index.js";
export { claudeMaskFilename, claudeReportedMaskPath, piMaskFilename, piReportedMaskPath } from "./server/bridge-tools/index.js";
export { EXEC_KILLER_ENV, EXEC_WRAPPER_ENV, validateExecWrapper } from "./server/exec-wrapper.js";
export { BRAIN_LOCK_KEY, GIT_LOCK_KEY, bashLockKey } from "./server/lock-keys.js";
export { rtkRewriteCommand } from "./server/rtk.js";
export { VERSION_PROBE_TIMEOUT_MS } from "./server/version-probe.js";
export { WEB_SEARCH_FALLBACK_ON, WEB_SEARCH_PROVIDERS, WEB_SEARCH_PROVIDER_KEYS, hasWebSearchCredential, readWebSearchOverride, readWebSearchRouting, resolveWebSearchConfigPath, webSearchBrief, webSearchProvider } from "./server/web-search.js";
export { BRIDGE_TOOL_POSTURE } from "./tool-contracts/bridge.js";
export { canonicalModelId, describeRetry, resolveThinkingLevel } from "./protocol-helpers.js";
export { execWrapperSpawnOptions, wrapCommand } from "./server/exec-wrapper.js";
export {
  handleAskUser,
  handleAskUserForm,
  handleAskUserList,
  handleAskUserRank,
  handleGetCurrentLocation,
  handleQueryActivity,
  handleRequestImageMask,
  handleShowBlock,
} from "./server/bridge-tools/index.js";
export type { ImageMaskHandlerOptions, LocationHandlerOptions } from "./server/bridge-tools/index.js";
