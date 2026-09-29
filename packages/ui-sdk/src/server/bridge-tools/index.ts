// The bridge tools' server half: the handlers that talk to the host bridge and
// the filesystem. Their names, descriptions, input schemas, payload schemas
// and prompt briefs live in `../../tool-contracts/`, which the browser imports
// too; `../index.ts` re-exports those alongside these, so a backend keeps one
// import site for both halves.

export { handleAskUser } from "./ask-user.js";
export {
  askUserListPayload,
  askUserListSpec,
  handleAskUserList,
} from "./ask-user-list.js";

export { handleGetCurrentLocation } from "./location.js";
export type { LocationHandlerOptions } from "./location.js";

export {
  handleRequestImageMask,
  claudeMaskFilename,
  piMaskFilename,
  claudeReportedMaskPath,
  piReportedMaskPath,
} from "./mask.js";
export type { ImageMaskHandlerOptions } from "./mask.js";

export { handleQueryActivity, wrapUntrustedData } from "./activity.js";

export { handleShowBlock } from "./show-block.js";

export { resolveInRepo } from "./resolve-in-repo.js";
