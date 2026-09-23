import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendActivityEvent,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";
import { AUTH_ERROR_CLASSES } from "./subscription.js";
import { usageFromResult } from "./usage.js";

/**
 * Stateful adapter that converts Claude SDK streaming messages to our
 * WebSocket protocol messages, and reports activity enrichment (subagent
 * lifecycle, usage, transcript excerpts) through the optional side channel.
 *
 * Must be instantiated per-session because it tracks state across streaming
 * events (e.g., which tool_use block is currently streaming).
 *
 * Subagent handling: messages produced inside a subagent carry
 * `parent_tool_use_id` (the Agent call that spawned it). Their TOOL activity
 * becomes normal tool frames tagged with `parentToolUseId` so clients nest
 * them; their TEXT (forwarded when `forwardSubagentText` is on) never becomes
 * chat `text_delta` frames — it goes to the activity side channel only, so a
 * chatty fan-out cannot flood the main transcript. Subagent partial stream
 * events are suppressed entirely.
 */
export class StreamAdapter {
  /** ID of the top-level tool_use block currently being streamed */
  private currentToolUseId: string = "";

  constructor(private readonly onActivity?: (event: BackendActivityEvent) => void) {}

  private report(event: BackendActivityEvent) {
    try {
      this.onActivity?.(event);
    } catch {
      // Observability must not break the observed turn.
    }
  }

  /**
   * Process an SDK message and return zero or more ServerMessages.
   */
  adapt(msg: SDKMessage): ServerMessage[] {
    const messages: ServerMessage[] = [];
    const parentToolUseId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;

    switch (msg.type) {
      case "stream_event": {
        // Partial streaming for subagent output is suppressed: the chat
        // surface streams the MAIN transcript only; subagent content arrives
        // at block granularity via the activity channel.
        if (parentToolUseId) break;
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
        // An account the runtime could not use: its own failure class, so the
        // host can tell an operator to log in again (#211). The frame the
        // client sees for it is #191's. Only the top-level turn's: a subagent
        // that failed is the parent's to handle, and a parent that completes
        // anyway did not fail.
        if (!parentToolUseId && msg.error && AUTH_ERROR_CLASSES.has(msg.error)) {
          const text = msg.message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
          this.report({ kind: "auth_failure", errorClass: msg.error, ...(text ? { message: text } : {}) });
        }
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            if (parentToolUseId) {
              // Subagent tool call: no partial streaming happened, so the
              // start frame (with linkage) and the complete frame land
              // together. Clients nest by parentToolUseId — the complete
              // carries it too, so an untagged same-name match can never
              // hijack a main-turn streaming tool entry.
              messages.push({
                type: "tool_use_start",
                toolUseId: block.id,
                toolName: block.name,
                parentToolUseId,
              });
            }
            messages.push({
              type: "tool_use_complete",
              toolUseId: block.id,
              toolName: block.name,
              input: block.input as Record<string, unknown>,
              ...(parentToolUseId ? { parentToolUseId } : {}),
            });
          } else if (block.type === "text" && parentToolUseId && block.text) {
            this.report({
              kind: "subagent_transcript",
              toolUseId: parentToolUseId,
              role: "assistant",
              text: block.text,
            });
          }
        }
        if (!parentToolUseId) {
          messages.push({ type: "status", status: "thinking" });
        }
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
            } else if (block.type === "text" && parentToolUseId && block.text) {
              this.report({
                kind: "subagent_transcript",
                toolUseId: parentToolUseId,
                role: "user",
                text: block.text,
              });
            }
          }
        }
        break;
      }

      case "result": {
        // Status BEFORE result: `result` is the turn's terminal frame and
        // must be the last thing a consumer sees for the turn.
        messages.push({ type: "status", status: "idle" });
        // This backend runs one query() per turn (each turn is its own SDK
        // subprocess), so result-level accounting IS per-turn — the SDK's
        // cumulative-across-turns caveat for streaming-input sessions does
        // not apply here. `modelUsage` is preferred per SDK guidance: it
        // covers subagents and sidechains, which `usage` excludes.
        const usage = usageFromResult(msg);
        if (msg.subtype === "success") {
          messages.push({
            type: "result",
            sessionId: msg.session_id,
            outcome: "success",
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns,
            isError: false,
            ...(usage ? { usage } : {}),
          });
        } else {
          messages.push({
            type: "result",
            sessionId: msg.session_id,
            outcome: "error",
            durationMs: msg.duration_ms ?? 0,
            numTurns: msg.num_turns ?? 0,
            isError: true,
            outcomeDetail: errorDetail(msg.subtype),
            // Real accounting is available on error results too — a failed
            // turn still spent tokens, and hiding that would under-report.
            // Absent stays absent: 0 would claim "free".
            ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
            ...(usage ? { usage } : {}),
          });
        }
        break;
      }

      case "system": {
        if (msg.subtype === "init") {
          messages.push({
            type: "status",
            status: "thinking",
            detail: "Session initialized",
          });
        } else if (msg.subtype === "task_started" && msg.tool_use_id) {
          // Remember task->tool linkage for updates that only carry task_id.
          if (msg.task_id) this.taskTools.set(msg.task_id, msg.tool_use_id);
          this.report({
            kind: "subagent_started",
            toolUseId: msg.tool_use_id,
            taskId: msg.task_id,
            subagentType: msg.subagent_type,
            description: msg.description,
            depth: msg.spawn_depth,
          });
        } else if (msg.subtype === "task_updated" && msg.task_id) {
          const status = msg.patch?.status;
          const toolUseId = this.taskTools.get(msg.task_id);
          if (toolUseId && isSubagentStatus(status)) {
            this.report({ kind: "subagent_status", toolUseId, status });
          }
        } else if (
          (msg.subtype === "task_progress" || msg.subtype === "task_notification") &&
          (msg.tool_use_id || msg.task_id)
        ) {
          const toolUseId = msg.tool_use_id ?? this.taskTools.get(msg.task_id);
          if (toolUseId) {
            this.report({
              kind: "subagent_status",
              toolUseId,
              status:
                msg.subtype === "task_notification" && msg.status === "completed"
                  ? "completed"
                  : "running",
              usage: msg.usage
                ? {
                    totalTokens: msg.usage.total_tokens,
                    toolUses: msg.usage.tool_uses,
                    durationMs: msg.usage.duration_ms,
                  }
                : undefined,
              summary: msg.summary,
            });
          }
        }
        break;
      }

      case "tool_progress" as any: {
        const tp = msg as any;
        // Subagent tool progress stays off the main status line.
        if (parentToolUseId) break;
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

  /** task_id -> spawning Agent tool_use_id, learned from task_started. */
  private taskTools = new Map<string, string>();
}

function isSubagentStatus(
  status: unknown
): status is "running" | "completed" | "failed" | "killed" | "paused" {
  return (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "killed" ||
    status === "paused"
  );
}

/** Map an SDK error subtype to the advisory `outcomeDetail` wire field. */
function errorDetail(subtype: string): string {
  switch (subtype) {
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
      return "max_budget";
    case "error_max_structured_output_retries":
      return "structured_output_retries";
    default:
      return "execution";
  }
}

/**
 * Stateless convenience for tests and one-off message adaptation.
 * For production streaming, use a StreamAdapter instance instead.
 */
export function adaptStreamEvent(msg: SDKMessage): ServerMessage[] {
  return new StreamAdapter().adapt(msg);
}
