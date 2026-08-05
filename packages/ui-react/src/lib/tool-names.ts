/**
 * MCP-prefixed names of brain-ui's own in-process tools, as they appear in the
 * tool-call stream. Kept in one place so the timeline, history reconstruction,
 * and per-tool rendering all agree on the identifiers.
 */
export const ASK_USER_TOOL_NAME = "mcp__brain-ui__ask_user";
export const GET_LOCATION_TOOL_NAME = "mcp__brain-ui__get_current_location";

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

export const isAskUserTool = (name: string | undefined): boolean =>
  !!name && normalizeToolName(name) === ASK_USER_TOOL_NAME;
export const isLocationTool = (name: string | undefined): boolean =>
  !!name && normalizeToolName(name) === GET_LOCATION_TOOL_NAME;
