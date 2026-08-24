/**
 * Per-turn span derivation: the host-side half of activity recording.
 *
 * The host already sees everything a baseline trace needs — the frames it
 * relays (tool starts/results, the terminal result), its own approval flow
 * (wait time, denials), and the turn lifecycle it owns (timeout, cancel).
 * A `TurnRecorder` turns that stream into spans, so EVERY backend gets a
 * full activity tree with zero backend work; the bridge's activity side
 * channel enriches with what only the backend sees (subagent lifecycle,
 * usage, transcripts).
 *
 * Terminal-write precedence (the write-once race): enrichment arrives on the
 * same ordered call path as frames, and the recorder buffers the result
 * frame's outcome/usage rather than closing the root span on sight. The ONE
 * terminal write for the root happens in `finish()` — after the backend's
 * startTurn resolved, when everything that could refine the outcome has
 * drained. Frame-derived outcome is the fallback, never a competing writer.
 *
 * Nothing here may fail the observed turn: every public method catches and
 * drops its own errors.
 */
import type {
  BackendActivityEvent,
  ServerMessage,
  TurnUsage,
} from "@schlessera/brain-ui-sdk/server";
import type { Logger } from "@opentelemetry/api-logs";

import type { ActivityStore, SpanOutcome, SpanUsage } from "./store.js";

export interface TurnRecorderDeps {
  store: ActivityStore;
  /** Called after any committed write so the live stream can pump. */
  onWrite?: () => void;
  log?: Logger;
}

export interface TurnRecorder {
  /** The run id (one run per turn). */
  readonly runId: string;
  observeFrame(msg: ServerMessage): void;
  observeActivity(event: BackendActivityEvent): void;
  /** The user's approval decision arrived for a gated tool call. */
  onApprovalDecision(toolUseId: string, allowed: boolean): void;
  /**
   * Close the turn: merge the buffered result enrichment into the root's
   * single terminal write, cascade-cancel anything left open, roll up.
   */
  finish(disposition: "success" | "error" | "cancelled" | "timeout"): void;
}

export function createTurnRecorder(
  deps: TurnRecorderDeps,
  turn: { turnId: string; sessionId: string | null }
): TurnRecorder {
  const { store, onWrite, log } = deps;
  const runId = turn.turnId;
  const rootSpanId = `${runId}:turn`;
  /** Spans opened for tool calls, keyed by toolUseId (span id === toolUseId). */
  const openTools = new Set<string>();
  const denied = new Set<string>();
  let sessionId = turn.sessionId ?? undefined;
  let rootStarted = false;
  let finished = false;
  /** Buffered terminal enrichment from the result frame. */
  let resultOutcome: SpanOutcome | null = null;
  let resultUsage: SpanUsage | undefined;
  let resultAttrs: Record<string, unknown> | undefined;

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log?.emit({
        severityText: "WARN",
        body: "activity recording failed; dropping",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  function ensureRoot() {
    if (rootStarted) return;
    rootStarted = true;
    store.startSpan({
      spanId: rootSpanId,
      runId,
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId,
      attrs: { "gen_ai.operation.name": "invoke_agent" },
    });
    onWrite?.();
  }

  function usageFromTurnUsage(usage: TurnUsage): SpanUsage {
    const models = usage.perModel ? Object.keys(usage.perModel) : [];
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      model: models.length === 1 ? models[0] : undefined,
    };
  }

  return {
    runId,

    observeFrame(msg) {
      guard(() => {
        if (finished) return;
        switch (msg.type) {
          case "session_info": {
            sessionId = msg.sessionId;
            ensureRoot();
            // The root may have been opened before the session had a name.
            store.patchSpan(rootSpanId, { attrs: { "session.id": msg.sessionId } });
            onWrite?.();
            break;
          }
          case "tool_use_start": {
            ensureRoot();
            const isSubagent = msg.toolName === "Agent";
            store.startSpan({
              spanId: msg.toolUseId,
              runId,
              parentSpanId: msg.parentToolUseId ?? rootSpanId,
              name: `execute_tool ${msg.toolName}`,
              kind: isSubagent ? "subagent" : "tool",
              origin: "session",
              sessionId,
              attrs: {
                "gen_ai.operation.name": isSubagent ? "invoke_agent" : "execute_tool",
                "gen_ai.tool.name": msg.toolName,
              },
            });
            openTools.add(msg.toolUseId);
            onWrite?.();
            break;
          }
          case "tool_approval_request": {
            // The span exists (tool_use_start preceded it). Nothing to write:
            // startedAt already marks the wait's beginning; the grant stamps
            // the wait/execution boundary.
            break;
          }
          case "tool_result": {
            if (!openTools.has(msg.toolUseId)) break;
            openTools.delete(msg.toolUseId);
            const outcome: SpanOutcome = denied.has(msg.toolUseId)
              ? "denied"
              : msg.isError
                ? "error"
                : "success";
            store.endSpan(msg.toolUseId, {
              outcome,
              reason: outcome === "error" ? clip(msg.output, 500) : undefined,
            });
            onWrite?.();
            break;
          }
          case "result": {
            // Buffered — the single terminal write happens in finish().
            resultOutcome =
              msg.outcome === "success"
                ? "success"
                : msg.outcome === "cancelled"
                  ? "cancelled"
                  : msg.outcomeDetail === "max_turns" || msg.outcomeDetail === "max_budget"
                    ? "timeout"
                    : "error";
            if (msg.usage) resultUsage = usageFromTurnUsage(msg.usage);
            if (typeof msg.costUsd === "number") {
              resultUsage = { ...(resultUsage ?? {}), costUsd: msg.costUsd };
            }
            resultAttrs = {
              ...(msg.outcomeDetail ? { "outcome.detail": msg.outcomeDetail } : {}),
              ...(msg.usage?.perModel
                ? { "gen_ai.usage.per_model": msg.usage.perModel }
                : {}),
            };
            break;
          }
          default:
            break;
        }
      });
    },

    observeActivity(event) {
      guard(() => {
        if (finished) return;
        switch (event.kind) {
          case "subagent_started": {
            store.patchSpan(event.toolUseId, {
              attrs: {
                "subagent.type": event.subagentType,
                "subagent.description": event.description,
                "subagent.task_id": event.taskId,
                "subagent.depth": event.depth,
              },
            });
            onWrite?.();
            break;
          }
          case "subagent_status": {
            if (event.usage) {
              store.patchSpan(event.toolUseId, {
                attrs: {
                  "subagent.total_tokens": event.usage.totalTokens,
                  "subagent.tool_uses": event.usage.toolUses,
                  ...(event.summary ? { "subagent.summary": event.summary } : {}),
                },
              });
            } else if (event.summary) {
              store.patchSpan(event.toolUseId, {
                attrs: { "subagent.summary": event.summary },
              });
            }
            onWrite?.();
            break;
          }
          case "subagent_transcript": {
            store.appendEvent(event.toolUseId, `transcript_${event.role}`, event.text);
            onWrite?.();
            break;
          }
        }
      });
    },

    onApprovalDecision(toolUseId, allowed) {
      guard(() => {
        if (allowed) {
          // Everything before this moment was approval wait, not execution.
          store.patchSpan(toolUseId, { waitUntil: Date.now() });
        } else {
          denied.add(toolUseId);
          // The denied outcome lands now — write-once makes the backend's
          // later error tool_result a no-op on this span.
          openTools.delete(toolUseId);
          store.endSpan(toolUseId, { outcome: "denied", reason: "user declined" });
        }
        onWrite?.();
      });
    },

    finish(disposition) {
      guard(() => {
        if (finished) return;
        finished = true;
        ensureRoot();
        // Merged precedence: the buffered result enrichment refines the
        // host's own disposition; the host wins only where the backend said
        // nothing. Cancellation/timeout are host-owned facts and always win.
        const outcome: SpanOutcome =
          disposition === "cancelled" || disposition === "timeout"
            ? disposition
            : (resultOutcome ?? disposition);
        store.endSpan(rootSpanId, {
          outcome,
          usage: resultUsage,
          attrs: resultAttrs,
        });
        // Anything still open died with the turn.
        store.cascadeClose(runId, "cancelled", `turn ${outcome}`);
        store.rollupRun(runId);
        onWrite?.();
      });
    },
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
