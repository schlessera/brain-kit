import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@brainform/ui-sdk";

/**
 * Stateful adapter that converts Claude SDK streaming messages
 * to our WebSocket protocol messages.
 *
 * Must be instantiated per-session because it tracks state across
 * streaming events (e.g., which tool_use block is currently streaming).
 */
export class StreamAdapter {
  /** ID of the tool_use block currently being streamed */
  private currentToolUseId: string = "";

  /**
   * Process an SDK message and return zero or more ServerMessages.
   */
  adapt(msg: SDKMessage): ServerMessage[] {
    const messages: ServerMessage[] = [];

    switch (msg.type) {
      case "stream_event": {
        const event = msg.event;

        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            this.currentToolUseId = block.id;
            messages.push({
              type: "tool_use_start",
              toolUseId: block.id,
              toolName: block.name,
            });
          } else if (block.type === "thinking") {
            // Thinking block started - deltas will follow
          } else if (block.type === "text") {
            // Text block started - deltas will follow
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            messages.push({ type: "text_delta", text: delta.text });
          } else if (delta.type === "thinking_delta") {
            messages.push({ type: "thinking_delta", text: delta.thinking });
          } else if (delta.type === "input_json_delta") {
            messages.push({
              type: "tool_input_delta",
              toolUseId: this.currentToolUseId,
              partialJson: delta.partial_json,
            });
          }
        } else if (event.type === "content_block_stop") {
          // Reset tool tracking when a block finishes
          // (next block_start will set a new ID if needed)
        }
        break;
      }

      case "assistant": {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            messages.push({
              type: "tool_use_complete",
              toolUseId: block.id,
              toolName: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
        messages.push({ type: "status", status: "thinking" });
        break;
      }

      case "user": {
        // User messages in the SDK stream contain tool_result blocks
        // (the output of tools that were executed)
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const output =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .filter((b: any) => b.type === "text")
                        .map((b: any) => b.text)
                        .join("\n")
                    : String(block.content ?? "");

              messages.push({
                type: "tool_result",
                toolUseId: block.tool_use_id,
                output,
                isError: block.is_error === true,
              });
            }
          }
        }
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          messages.push({
            type: "result",
            sessionId: msg.session_id,
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns,
            isError: false,
          });
        } else {
          messages.push({
            type: "result",
            sessionId: msg.session_id,
            costUsd: 0,
            durationMs: 0,
            numTurns: 0,
            isError: true,
          });
        }
        messages.push({ type: "status", status: "idle" });
        break;
      }

      case "system": {
        if (msg.subtype === "init") {
          messages.push({
            type: "status",
            status: "thinking",
            detail: "Session initialized",
          });
        }
        break;
      }

      case "tool_progress" as any: {
        const tp = msg as any;
        messages.push({
          type: "status",
          status: "tool_executing",
          detail: `${tp.tool_name}... (${Math.round(tp.elapsed_time_seconds)}s)`,
        });
        break;
      }

      default:
        break;
    }

    return messages;
  }
}

/**
 * Stateless convenience for tests and one-off message adaptation.
 * For production streaming, use a StreamAdapter instance instead.
 */
export function adaptStreamEvent(msg: SDKMessage): ServerMessage[] {
  return new StreamAdapter().adapt(msg);
}
