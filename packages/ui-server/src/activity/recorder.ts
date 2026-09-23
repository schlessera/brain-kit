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
import {
  SPAN_OP_EXECUTE_TOOL,
  SPAN_OP_INVOKE_AGENT,
  SPAN_TOOL_NAME_PREFIX,
  type ApprovalChannel,
  type BillingMode,
  type PricingRoute,
} from "@schlessera/brain-ui-sdk/protocol";
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
  /** Record that this turn's principal was revoked while work kept running. */
  recordPrincipalRevocation(principalId: string): void;
  /** Record a live follow-up that joined this already-running turn. */
  recordFollowUp(principalId: string): void;
  /** Record who cancelled this turn or an interactive prompt within it. */
  recordCancellation(principalId: string, kind?: "turn" | "ask_user"): void;
  /** Record who answered an ask-user interaction. */
  recordAskUserResponse(principalId: string): void;
  /**
   * The user's approval decision arrived for a gated tool call. `channel` is
   * how it arrived, when the client said; absent is stored as absent.
   */
  onApprovalDecision(
    toolUseId: string,
    decision: "allow" | "always_allow" | "deny",
    requestKind: "tool" | "command",
    principalId?: string,
    channel?: ApprovalChannel
  ): void;
  /**
   * Close the turn: merge the buffered result enrichment into the root's
   * single terminal write, cascade-cancel anything left open, roll up.
   */
  finish(disposition: "success" | "error" | "cancelled" | "timeout"): void;
}

export function createTurnRecorder(
  deps: TurnRecorderDeps,
  turn: {
    turnId: string;
    sessionId: string | null;
    /** The RESOLVED inference profile this turn runs on (post pin-drop fallback). */
    profileId?: string;
    /** Billing classification of that profile, resolved at run start (U3). */
    billingMode?: BillingMode;
    /** Which pricing catalog that profile bills through, resolved with it. */
    pricingRoute?: PricingRoute;
    /** Principal that initiated this turn; absent means unattributed. */
    principalId?: string;
  }
): TurnRecorder {
  const { store, onWrite, log } = deps;
  const runId = turn.turnId;
  const rootSpanId = `${runId}:turn`;
  let sessionId = turn.sessionId ?? undefined;
  let rootStarted = false;
  let finished = false;
  /** Buffered terminal enrichment from the result frame. */
  let resultOutcome: SpanOutcome | null = null;
  let resultUsage: SpanUsage | undefined;
  let resultAttrs: Record<string, unknown> | undefined;
  let principalRevocationRecorded = false;

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
      name: SPAN_OP_INVOKE_AGENT,
      kind: "turn",
      origin: "session",
      sessionId,
      principalId: turn.principalId,
      // Profile, billing and pricing route ride the ROOT span so the rollup
      // can price the run without any registry or env lookup of its own (a
      // root missing the billing attr falls back to env classification at
      // rollup time; a root missing the route prices by model id alone, since
      // this process's environment says nothing about where the turn's
      // requests went).
      attrs: {
        "gen_ai.operation.name": SPAN_OP_INVOKE_AGENT,
        ...(turn.profileId ? { "brain.profile_id": turn.profileId } : {}),
        ...(turn.billingMode ? { "brain.billing_mode": turn.billingMode } : {}),
        ...(turn.pricingRoute ? { "brain.pricing_route": turn.pricingRoute } : {}),
      },
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
              name: `${SPAN_TOOL_NAME_PREFIX}${msg.toolName}`,
              kind: isSubagent ? "subagent" : "tool",
              origin: "session",
              sessionId,
              attrs: {
                "gen_ai.operation.name": isSubagent ? SPAN_OP_INVOKE_AGENT : SPAN_OP_EXECUTE_TOOL,
                "gen_ai.tool.name": msg.toolName,
              },
            });
            onWrite?.();
            break;
          }
          case "tool_approval_request": {
            // The span exists (tool_use_start preceded it). Nothing to write:
            // startedAt already marks the wait's beginning; the grant stamps
            // the wait/execution boundary.
            break;
          }
          case "tool_use_complete": {
            // The complete input object in one frame — tool_input_delta
            // frames stay ignored, no accumulation needed. Recorded as a
            // span event so the Activity drill-in can expand the call (R14).
            store.appendEvent(
              msg.toolUseId,
              "tool_input",
              safeStringify(msg.input),
              undefined,
              PAYLOAD_EVENT_CAP
            );
            onWrite?.();
            break;
          }
          case "tool_result": {
            // endSpan is write-once: a span already closed (a denial landed
            // the outcome first) rejects this as a no-op, and an unknown
            // span id is equally a no-op — no bookkeeping set needed.
            const outcome: SpanOutcome = msg.isError ? "error" : "success";
            store.endSpan(msg.toolUseId, {
              outcome,
              reason: outcome === "error" ? clip(msg.output, 500) : undefined,
            });
            // Error output rides along too — a failed call's output is what
            // the drill-in needs most. appendEvent no-ops on unknown spans.
            store.appendEvent(msg.toolUseId, "tool_output", msg.output, undefined, PAYLOAD_EVENT_CAP);
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
              },
            });
            onWrite?.();
            break;
          }
          case "subagent_status": {
            const attrs = {
              ...(event.usage ? { "subagent.total_tokens": event.usage.totalTokens } : {}),
              ...(event.summary ? { "subagent.summary": event.summary } : {}),
            };
            if (Object.keys(attrs).length > 0) {
              store.patchSpan(event.toolUseId, { attrs });
              onWrite?.();
            }
            break;
          }
          case "subagent_transcript": {
            store.appendEvent(event.toolUseId, `transcript_${event.role}`, event.text);
            onWrite?.();
            break;
          }
          case "permission_denied": {
            // The same landing a user's denial gets in requestPermission: the
            // outcome is written now, so the backend's later error tool_result
            // is a write-once no-op and the span reads as denied rather than
            // as a call that failed. The request never reached the host, so
            // there is no principal and no approval_decision event.
            store.appendEvent(event.toolUseId, "approval_decision", {
              decision: "deny",
              requestKind: event.requestKind,
            });
            store.endSpan(event.toolUseId, {
              outcome: "denied",
              reason: event.reason,
            });
            onWrite?.();
            break;
          }
        }
      });
    },

    recordPrincipalRevocation(principalId) {
      guard(() => {
        if (finished || principalRevocationRecorded) return;
        ensureRoot();
        store.appendEvent(rootSpanId, "principal_revoked", { principalId });
        principalRevocationRecorded = true;
        onWrite?.();
      });
    },

    recordFollowUp(principalId) {
      guard(() => {
        if (finished) return;
        ensureRoot();
        store.appendEvent(rootSpanId, "follow_up", { principalId });
        onWrite?.();
      });
    },

    recordCancellation(principalId, kind = "turn") {
      guard(() => {
        if (finished) return;
        ensureRoot();
        store.appendEvent(rootSpanId, `${kind}_cancelled`, { principalId });
        onWrite?.();
      });
    },

    recordAskUserResponse(principalId) {
      guard(() => {
        if (finished) return;
        ensureRoot();
        store.appendEvent(rootSpanId, "ask_user_response", { principalId });
        onWrite?.();
      });
    },

    onApprovalDecision(toolUseId, decision, requestKind, principalId, channel) {
      guard(() => {
        if (principalId) {
          // One tool can raise several approval requests. The span-level actor
          // remains the latest responder for compact views, while this
          // append-only event preserves every decision and actor in order.
          // The channel rides beside them only when the client named one, so
          // a decision without it is stored exactly as it always was.
          store.appendEvent(toolUseId, "approval_decision", {
            principalId,
            decision,
            requestKind,
            ...(channel ? { channel } : {}),
          });
          store.patchSpan(toolUseId, { principalId });
        }
        if (decision !== "deny") {
          // Everything before this moment was approval wait, not execution.
          store.patchSpan(toolUseId, { waitUntil: Date.now() });
        } else {
          // The denied outcome lands now — write-once makes the backend's
          // later error tool_result a no-op on this span.
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

/** Cap for recorded tool input/output payload events — roomier than the
 *  500-char outcome-reason clip, still far under the store's 16 KB event cap.
 *  Passed to appendEvent, whose clipping sets the wire `truncated` flag. */
const PAYLOAD_EVENT_CAP = 4096;

/** Tool inputs are arbitrary values: serialization must never take the turn
 *  down with it (BigInt members throw; a toJSON can return undefined). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
