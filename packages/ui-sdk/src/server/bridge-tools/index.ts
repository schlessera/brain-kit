export {
  ASK_USER_TOOL_NAME,
  ASK_USER_DESCRIPTION,
  ASK_USER_INPUT_SCHEMA,
  handleAskUser,
} from "./ask-user.js";
export type { AskUserInput, AskUserPayload } from "./ask-user.js";

export {
  GET_CURRENT_LOCATION_TOOL_NAME,
  GET_CURRENT_LOCATION_DESCRIPTION,
  GET_CURRENT_LOCATION_INPUT_SCHEMA,
  handleGetCurrentLocation,
} from "./location.js";
export type {
  GetCurrentLocationInput,
  LocationPayload,
  LocationHandlerOptions,
} from "./location.js";

export {
  REQUEST_IMAGE_MASK_TOOL_NAME,
  REQUEST_IMAGE_MASK_DESCRIPTION,
  REQUEST_IMAGE_MASK_INPUT_SCHEMA,
  handleRequestImageMask,
  claudeMaskFilename,
  piMaskFilename,
  claudeReportedMaskPath,
  piReportedMaskPath,
} from "./mask.js";
export type {
  RequestImageMaskInput,
  ImageMaskPayload,
  ImageMaskHandlerOptions,
} from "./mask.js";

export {
  QUERY_ACTIVITY_TOOL_NAME,
  QUERY_ACTIVITY_DESCRIPTION,
  QUERY_ACTIVITY_INPUT_SCHEMA,
  handleQueryActivity,
  wrapUntrustedData,
} from "./activity.js";
export type { QueryActivityInput } from "./activity.js";

export { resolveInRepo } from "./resolve-in-repo.js";

import { ASK_USER_TOOL_NAME } from "./ask-user.js";
import { QUERY_ACTIVITY_TOOL_NAME } from "./activity.js";
import { GET_CURRENT_LOCATION_TOOL_NAME } from "./location.js";
import { REQUEST_IMAGE_MASK_TOOL_NAME } from "./mask.js";

export type BridgeToolAdapter = "claude" | "pi";
export type BridgeToolName =
  | typeof ASK_USER_TOOL_NAME
  | typeof GET_CURRENT_LOCATION_TOOL_NAME
  | typeof REQUEST_IMAGE_MASK_TOOL_NAME
  | typeof QUERY_ACTIVITY_TOOL_NAME;

const names = [
  ASK_USER_TOOL_NAME,
  GET_CURRENT_LOCATION_TOOL_NAME,
  REQUEST_IMAGE_MASK_TOOL_NAME,
  QUERY_ACTIVITY_TOOL_NAME,
] as const;

/** The four auto-allowed bridge tools and the names each backend exposes. */
export const BRIDGE_TOOL_POSTURE = Object.freeze({
  names,
  claudePrefix: "mcp__brain-ui__" as const,
  visibleName(name: BridgeToolName, adapter: BridgeToolAdapter): string {
    return adapter === "claude" ? `mcp__brain-ui__${name}` : name;
  },
  allowedTools(adapter: BridgeToolAdapter): readonly string[] {
    return names.map((name) =>
      adapter === "claude" ? `mcp__brain-ui__${name}` : name
    );
  },
});
