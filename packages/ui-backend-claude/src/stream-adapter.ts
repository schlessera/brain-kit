import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendActivityEvent,
  ModelUsage,
  ServerMessage,
  TurnUsage,
} from "@schlessera/brain-ui-sdk/server";

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
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            if (parentToolUseId) {
              // Subagent tool call: no partial streaming happened, so the
              // start frame (with linkage) and the complete frame land
              // together. Clients nest by parentToolUseId.
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
        const sys = msg as any;
        if (sys.subtype === "init") {
          messages.push({
            type: "status",
            status: "thinking",
            detail: "Session initialized",
          });
        } else if (sys.subtype === "task_started" && sys.tool_use_id) {
          this.report({
            kind: "subagent_started",
            toolUseId: sys.tool_use_id,
            taskId: sys.task_id,
            subagentType: sys.subagent_type,
            description: sys.description,
            depth: sys.spawn_depth,
          });
        } else if (sys.subtype === "task_updated" && sys.task_id) {
          const status = sys.patch?.status;
          const toolUseId = this.taskTools.get(sys.task_id);
          if (toolUseId && isSubagentStatus(status)) {
            this.report({ kind: "subagent_status", toolUseId, status });
          }
        } else if (
          (sys.subtype === "task_progress" || sys.subtype === "task_notification") &&
          (sys.tool_use_id || sys.task_id)
        ) {
          const toolUseId = sys.tool_use_id ?? this.taskTools.get(sys.task_id);
          if (toolUseId) {
            this.report({
              kind: "subagent_status",
              toolUseId,
              status: sys.status === "completed" ? "completed" : "running",
              usage: sys.usage
                ? {
                    totalTokens: sys.usage.total_tokens,
                    toolUses: sys.usage.tool_uses,
                    durationMs: sys.usage.duration_ms,
                  }
                : undefined,
              summary: sys.summary,
            });
          }
        }
        // Remember task->tool linkage for updates that only carry task_id.
        if (sys.subtype === "task_started" && sys.task_id && sys.tool_use_id) {
          this.taskTools.set(sys.task_id, sys.tool_use_id);
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

/** Build the wire usage block from a result message's accounting. */
function usageFromResult(msg: {
  usage?: unknown;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
}): TurnUsage | undefined {
  const models = msg.modelUsage;
  if (!models || Object.keys(models).length === 0) return undefined;
  const perModel: Record<string, ModelUsage> = {};
  const totals: Required<Pick<ModelUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">> =
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const [model, u] of Object.entries(models)) {
    perModel[model] = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadInputTokens,
      cacheCreationTokens: u.cacheCreationInputTokens,
      costUsd: u.costUSD,
    };
    totals.inputTokens += u.inputTokens ?? 0;
    totals.outputTokens += u.outputTokens ?? 0;
    totals.cacheReadTokens += u.cacheReadInputTokens ?? 0;
    totals.cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
  }
  return { ...totals, perModel };
}

/**
 * Stateless convenience for tests and one-off message adaptation.
 * For production streaming, use a StreamAdapter instance instead.
 */
export function adaptStreamEvent(msg: SDKMessage): ServerMessage[] {
  return new StreamAdapter().adapt(msg);
}
