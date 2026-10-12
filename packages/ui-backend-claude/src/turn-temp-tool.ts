import { tool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { BRIDGE_TOOL_POSTURE, TURN_TEMP_DESCRIPTION, TURN_TEMP_INPUT_SCHEMA, TURN_TEMP_TOOL_NAME as SHARED_TOOL_NAME } from "@schlessera/brain-ui-sdk/server";
import { createTurnTempPressure, handleTurnTemp, turnTempSpace, type TurnTempAccess,
  type TurnTempPurgeRecord } from "@schlessera/brain-ui-sdk/internal";

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const TURN_TEMP_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(SHARED_TOOL_NAME, "claude");

/**
 * `turn_temp` (#1703): usage and purge of the running worker's private `/tmp`,
 * through the descriptor the server holds. Runs in the server, never in the
 * worker, and reaches nothing but that worker's turn temp.
 */
export function createTurnTempTool(access: TurnTempAccess, record?: (event: TurnTempPurgeRecord) => void) {
  return tool(SHARED_TOOL_NAME, TURN_TEMP_DESCRIPTION, TURN_TEMP_INPUT_SCHEMA.shape, async (input) => {
    try {
      const payload = handleTurnTemp(TURN_TEMP_INPUT_SCHEMA.parse(input), access, record);
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : "turn_temp failed" }], isError: true };
    }
  });
}

/**
 * After each tool call, tells the agent once when its turn temp passes 80% of
 * the allowance, and when it is full, naming the `turn_temp` tool (#1703).
 * Read from the worker's own tmpfs through the held descriptor, against the
 * allowance it was mounted with.
 */
export function createTurnTempPressureHook(access: Pick<TurnTempAccess, "root" | "allowanceBytes">): HookCallback {
  const pressure = createTurnTempPressure(access.allowanceBytes, TURN_TEMP_TOOL_NAME);
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return { continue: true };
    const root = access.root();
    if (!root) return { continue: true };
    let message: string | undefined;
    try { message = pressure(turnTempSpace(root, access.allowanceBytes)); } catch { return { continue: true }; }
    if (!message) return { continue: true };
    return { continue: true, hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: message } };
  };
}
