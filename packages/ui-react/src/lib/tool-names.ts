/**
 * Names of brain-ui's own in-process tools, as they appear in the tool-call
 * stream. The names themselves come from the SDK's tool contracts — this
 * module only derives the per-backend spellings the client has to match, so
 * the timeline, history reconstruction and per-tool rendering all agree.
 */

import {
  ASK_USER_CONTRACT,
  ASK_USER_LIST_CONTRACT,
  GET_CURRENT_LOCATION_CONTRACT,
  SHOW_BLOCK_CONTRACT,
  visibleToolName,
} from "@schlessera/brain-ui-sdk/client";

export const ASK_USER_TOOL_NAME = visibleToolName(ASK_USER_CONTRACT.name, "claude");
export const GET_LOCATION_TOOL_NAME = visibleToolName(
  GET_CURRENT_LOCATION_CONTRACT.name,
  "claude"
);

const LEGACY_MCP_PREFIX = "mcp__brain_ui__";
const MCP_PREFIX = "mcp__brain-ui__";

/**
 * Pre-rename transcripts used the `mcp__brain_ui__` server prefix; the server is
 * now `mcp__brain-ui__`. Normalize the legacy prefix so old tool calls resolve
 * to the same identifiers (special-card renderers, icons) as new ones instead of
 * falling back to a raw JSON blob.
 */
export function normalizeToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_PREFIX)
    ? MCP_PREFIX + name.slice(LEGACY_MCP_PREFIX.length)
    : name;
}

// The pi backend registers its ask-user tool under the bare name.
const PI_ASK_USER_TOOL_NAME = visibleToolName(ASK_USER_CONTRACT.name, "pi");

export const isAskUserTool = (name: string | undefined): boolean =>
  !!name &&
  (normalizeToolName(name) === ASK_USER_TOOL_NAME ||
    name === PI_ASK_USER_TOOL_NAME);

const ASK_USER_LIST_TOOL_NAME = visibleToolName(ASK_USER_LIST_CONTRACT.name, "claude");
const PI_ASK_USER_LIST_TOOL_NAME = visibleToolName(ASK_USER_LIST_CONTRACT.name, "pi");

/** An `ask_user_list` call (#583), under either backend's spelling. */
export const isAskUserListTool = (name: string | undefined): boolean =>
  !!name &&
  (normalizeToolName(name) === ASK_USER_LIST_TOOL_NAME ||
    name === PI_ASK_USER_LIST_TOOL_NAME);

/**
 * A call that opens an ask exchange — `ask_user` or `ask_user_list`. Both
 * consume `ChatMessage.askUserExchanges` in call order, so the transcript
 * must count them together or a list card would take a question's slot.
 */
export const isAskExchangeTool = (name: string | undefined): boolean =>
  isAskUserTool(name) || isAskUserListTool(name) || isAskUserRankTool(name) || isAskUserFormTool(name);

const SHOW_BLOCK_TOOL_NAME = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
const PI_SHOW_BLOCK_TOOL_NAME = visibleToolName(SHOW_BLOCK_CONTRACT.name, "pi");

/** A `show_block` call, under either backend's spelling (D41). */
export const isShowBlockTool = (name: string | undefined): boolean =>
  !!name &&
  (normalizeToolName(name) === SHOW_BLOCK_TOOL_NAME ||
    name === PI_SHOW_BLOCK_TOOL_NAME);

// `isLocationTool` used to live here and was never called: the location result
// is rendered by the contract-bound renderer now, which matches every spelling
// of the name rather than the MCP-prefixed one alone.

/** A ranking exchange, under either backend spelling. */
export const isAskUserRankTool = (name: string | undefined): boolean =>
  name === "ask_user_rank" || name === "mcp__brain-ui__ask_user_rank";

export const isAskUserFormTool = (name: string | undefined): boolean => name === "ask_user_form" || name === "mcp__brain-ui__ask_user_form";
