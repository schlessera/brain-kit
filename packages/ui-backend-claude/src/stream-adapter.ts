import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describeRetry } from "@schlessera/brain-ui-sdk/internal";
import type {
  BackendActivityEvent,
  ServerMessage,
  TurnFailure,
  TurnRetry,
} from "@schlessera/brain-ui-sdk/server";
import { subscriptionAuthAction } from "@schlessera/brain-ui-sdk/server";
import { AUTH_ERROR_CLASSES } from "./subscription.js";
import { usageFromResult } from "./usage.js";

/**
 * Stateful adapter that converts Claude SDK streaming messages to our
 * WebSocket protocol messages, and reports activity enrichment (subagent
 * lifecycle, usage, transcript excerpts) through the optional side channel.
 *
 * Must be instantiated per-turn because it tracks state across streaming
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
  /**
   * The top-level API error the runtime reported as an assistant message
   * (#575). It carries the class; the turn's `result` carries the status and
   * decides whether the turn failed.
   */
  private apiError: TurnFailure | null = null;
  private retryAttempts = 0;
  private resetsAt: number | undefined;


  constructor(
    private readonly onActivity?: (event: BackendActivityEvent) => void,
    private readonly options: StreamAdapterOptions = {}
  ) {}

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
        if (!parentToolUseId && msg.error) {
          const text = msg.message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
          if (AUTH_ERROR_CLASSES.has(msg.error)) {
            this.report({ kind: "auth_failure", errorClass: msg.error, ...(text ? { message: text } : {}) });
          }
          // The runtime's API-error message: its text arrives here and never
          // as deltas, so it is kept for the terminal frame rather than
          // streamed as if the model had said it (#575).
          this.apiError = this.failure(msg.error, text || msg.error, statusFromText(text));
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
        // One query() subprocess per turn, so cost and `modelUsage` (preferred:
        // it covers subagents and sidechains, which `usage` excludes) cover the
        // turn. A follow-up the CLI runs as a continuation adds a result whose
        // cost and modelUsage are cumulative over the process; the runner
        // keeps the last one and adds the earlier runs' turns and duration.
        const usage = usageFromResult(msg);
        if (msg.subtype === "success" && !msg.is_error) {
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
          // `success` with `is_error` is how the runtime ends a turn on an
          // API error: the error text is the `result`, the status rides
          // beside it (#191). An error subtype carries a failure only when
          // the runtime reported an API error first.
          const failure =
            msg.subtype === "success"
              ? this.resultFailure(msg.result, msg.api_error_status)
              : this.pendingFailure();
          messages.push({
            type: "result",
            sessionId: msg.session_id,
            outcome: "error",
            durationMs: msg.duration_ms ?? 0,
            numTurns: msg.num_turns ?? 0,
            isError: true,
            outcomeDetail: msg.subtype === "success" ? "api_error" : errorDetail(msg.subtype),
            ...(failure ? { failure } : {}),
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
        } else if (msg.subtype === "api_retry") {
          if (!parentToolUseId) this.retryAttempts++;
          // A failed call the runtime is backing off from: without this, a
          // turn waiting out a rate limit looks exactly like a hung one.
          const retry: TurnRetry = {
            attempt: msg.attempt,
            maxAttempts: msg.max_retries,
            delayMs: msg.retry_delay_ms,
            errorClass: msg.error,
            ...(typeof msg.error_status === "number" ? { status: msg.error_status } : {}),
          };
          messages.push({ type: "status", status: "thinking", detail: describeRetry(retry), retry });
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

      case "rate_limit_event": {
        // Claude Code 2.1.283 compares this value * 1000 with Date.now():
        // the runtime reports seconds; the wire's timestamp is milliseconds.
        if (!parentToolUseId && msg.rate_limit_info.status === "rejected") {
          const seconds = msg.rate_limit_info.resetsAt;
          this.resetsAt = typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
            && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
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

  /**
   * The API error the runtime reported before its stream ended, for a turn
   * whose terminal frame the runner has to build itself (no `result` came).
   */
  pendingFailure(): TurnFailure | null {
    return this.apiError ? this.observedFailure(this.apiError) : null;
  }

  /**
   * The failure a `success` result with `is_error` reports: the class from
   * the API-error message that preceded it, when one did; the status from
   * the result, which is the only place the runtime states it.
   */
  private resultFailure(text: string | undefined, apiStatus: number | null | undefined): TurnFailure {
    const status = typeof apiStatus === "number" ? apiStatus : this.apiError?.status;
    const message = this.apiError?.message ?? (text?.trim() || "The model call failed.");
    return this.observedFailure(this.failure(this.apiError?.errorClass ?? "unknown", message, status));
  }

  private observedFailure(failure: TurnFailure): TurnFailure {
    return { ...failure,
      ...(this.retryAttempts > 0 ? { attempts: this.retryAttempts } : {}),
      ...(this.resetsAt !== undefined ? { resetsAt: this.resetsAt } : {}),
    };
  }

  private failure(errorClass: string, message: string, status: number | undefined): TurnFailure {
    return {
      errorClass,
      ...(status !== undefined ? { status } : {}),
      message,
      // Only a subscription turn's auth failure gets the #254 instruction: a
      // profile billing its own key failed on that key, not the subscription.
      ...(this.options.subscriptionAuth && AUTH_ERROR_CLASSES.has(errorClass)
        ? { authAction: subscriptionAuthAction(errorClass) }
        : {}),
    };
  }
}

export interface StreamAdapterOptions {
  /**
   * The turn runs on the Claude subscription, so an auth failure carries the
   * subscription's `authAction` (#254).
   */
  subscriptionAuth?: boolean;
}

/**
 * The HTTP status an API-error text states, as the runtime words it: "API
 * Error: 400 …". Nothing else is read as a status.
 */
export function statusFromText(text: string): number | undefined {
  const match = /\bAPI Error: ([1-5]\d\d)\b/.exec(text);
  return match ? Number(match[1]) : undefined;
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
