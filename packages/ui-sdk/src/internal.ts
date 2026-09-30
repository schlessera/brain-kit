/** First-party implementation sharing. No compatibility guarantee; use the same lockstep version. */
export { DEFAULT_CONFIRM_BASH_PATTERNS, ARCHIVING_UPDATE_REASON, archivesDocument, bashCommand } from "./server/confirm-patterns.js";
export type { SubprocessEnvAudience } from "./server/subprocess-env.js";
export { SUBPROCESS_ENV, filterSubprocessEnv, parseSubprocessEnvExtra } from "./server/subprocess-env.js";
