/**
 * Tool component contracts — the D3 seam.
 *
 * Importable from both halves of the app: the server builds tool definitions
 * and the system-prompt brief from these, the browser binds renderers and
 * parses payloads from the same objects. Nothing here imports React or a node
 * built-in.
 */

export type {
  ToolAdapter,
  ToolContract,
  ToolComponentContract,
  ToolInput,
  ToolPayload,
} from "./contract.js";
export {
  BRIDGE_MCP_PREFIX,
  defineToolContract,
  defineToolComponentContract,
  parseToolPayload,
  toolBriefLines,
  toolInputJsonSchema,
  visibleToolName,
} from "./contract.js";

export {
  ASK_USER_CONTRACT,
  ASK_USER_DESCRIPTION,
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_LIST_CONTRACT,
  ASK_USER_LIST_DESCRIPTION,
  ASK_USER_LIST_INPUT_SCHEMA,
  ASK_USER_LIST_PAYLOAD_SCHEMA,
  ASK_USER_LIST_TOOL_NAME,
  ASK_USER_PAYLOAD_SCHEMA,
  ASK_USER_RANK_CONTRACT,
  ASK_USER_RANK_DESCRIPTION,
  ASK_USER_RANK_INPUT_SCHEMA,
  ASK_USER_RANK_PAYLOAD_SCHEMA,
  ASK_USER_RANK_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  BRIDGE_TOOL_CONTRACTS,
  GET_CURRENT_LOCATION_CONTRACT,
  GET_CURRENT_LOCATION_DESCRIPTION,
  GET_CURRENT_LOCATION_INPUT_SCHEMA,
  GET_CURRENT_LOCATION_TOOL_NAME,
  IMAGE_MASK_PAYLOAD_SCHEMA,
  LOCATION_PAYLOAD_SCHEMA,
  QUERY_ACTIVITY_CONTRACT,
  QUERY_ACTIVITY_DESCRIPTION,
  QUERY_ACTIVITY_INPUT_SCHEMA,
  QUERY_ACTIVITY_TOOL_NAME,
  REQUEST_IMAGE_MASK_CONTRACT,
  REQUEST_IMAGE_MASK_DESCRIPTION,
  REQUEST_IMAGE_MASK_INPUT_SCHEMA,
  REQUEST_IMAGE_MASK_TOOL_NAME,
  bridgeContractForToolName,
} from "./bridge.js";
export type {
  AskUserInput,
  AskUserListInput,
  AskUserListPayload,
  AskUserPayload,
  AskUserRankInput,
  AskUserRankPayload,
  BridgeToolName,
  GetCurrentLocationInput,
  ImageMaskPayload,
  LocationPayload,
  QueryActivityInput,
  RequestImageMaskInput,
} from "./bridge.js";
export {
  BLOCK_SCHEMA,
  SHOW_BLOCK_CONTRACT,
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  SHOW_BLOCK_PAYLOAD_SCHEMA,
  SHOW_BLOCK_TOOL_NAME,
} from "./blocks.js";
export type {
  Block,
  BlockKind,
  ShowBlockInput,
  ShowBlockPayload,
} from "./blocks.js";

export {
  ASK_USER_FORM_CONTRACT,
  ASK_USER_FORM_DESCRIPTION,
  ASK_USER_FORM_INPUT_SCHEMA,
  ASK_USER_FORM_NODE_SCHEMA,
  ASK_USER_FORM_PAYLOAD_SCHEMA,
  ASK_USER_FORM_TOOL_NAME,
} from "./form.js";
export type {
  AskUserFormAnswer,
  AskUserFormAnswers,
  AskUserFormInput,
  AskUserFormLimits,
  AskUserFormMultiAnswer,
  AskUserFormNode,
  AskUserFormPayload,
  AskUserFormRankAnswer,
  AskUserFormScaleAnswer,
  AskUserFormSingleAnswer,
  AskUserFormSpec,
} from "./form.js";
