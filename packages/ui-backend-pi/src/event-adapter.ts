import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";

/**
 * Pure event → frame mapping (exported for tests). Returns the ordered frames a
 * single pi AgentSession event produces; unmapped events return [].
 */
export function mapPiEvent(ev: AgentSessionEvent): ServerMessage[] {
  switch (ev.type) {
    case "message_update": {
      const event = ev.assistantMessageEvent;
      if (event.type === "text_delta") return [{ type: "text_delta", text: event.delta }];
      if (event.type === "thinking_delta") {
        return [{ type: "thinking_delta", text: event.delta }];
      }
      return [];
    }
    case "tool_execution_start":
      // Tool args arrive complete (not streamed): emit start + complete with
      // the full input; the protocol allows omitting input_delta frames.
      return [
        { type: "tool_use_start", toolUseId: ev.toolCallId, toolName: ev.toolName },
        {
          type: "tool_use_complete",
          toolUseId: ev.toolCallId,
          toolName: ev.toolName,
          input: (ev.args ?? {}) as Record<string, unknown>,
        },
        { type: "status", status: "tool_executing" },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          toolUseId: ev.toolCallId,
          output: toolResultText(ev.result),
          isError: ev.isError,
        },
      ];
    default:
      return [];
  }
}

/** Extract the text of a pi AgentToolResult's content parts. */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}
