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
  FIRST_PARTY_FAILURE_CLASSES,
  SPAN_OP_EXECUTE_TOOL,
  SPAN_OP_INVOKE_AGENT,
  SPAN_TOOL_NAME_PREFIX,
  type ApprovalChannel,
  type BillingMode,
  type PricingRoute,
} from "@schlessera/brain-ui-sdk/protocol";
import type { Logger } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";

import type { GovernanceEventInput, GovernanceProfile } from "../governance/events.js";
import { recordTurnRoadblocks, type TracedCall, type UsageSample } from "../governance/roadblocks.js";

import { redactCredentials, type RuntimeStatus } from "./runtime-status.js";
import type { ActivityStore, SpanOutcome, SpanUsage } from "./store.js";

export interface TurnRecorderDeps {
  store: ActivityStore;
  /** Where the runtime a turn reported, and its auth failures, are kept for /api/status. */
  runtime?: Pick<RuntimeStatus, "observe" | "authFailure"> & Partial<Pick<RuntimeStatus, "subscriptionProven" | "recordWorkerHost">>;
  /** Called after any committed write so the live stream can pump. */
  onWrite?: () => void;
  log?: Logger;
  /** The governance-event writer (#1651). Absent: interventions stay span events only. */
  governance?: (input: GovernanceEventInput) => void;
  /**
   * The server database the turn's roadblocks are classified against and
   * recorded in at finish (#1671): it reads the turn's other governance
   * events as well as writing. Absent records none.
   */
  governanceDb?: Database;
}

export interface TurnRecorder {
  setMainModel(model: string): void;
  setWorkerProfile(profile: GovernanceProfile): void;
  /** The run id (one run per turn). */
  readonly runId: string;
  observeFrame(msg: ServerMessage): void;
  observeActivity(event: BackendActivityEvent): void;
  /** Successful server checkpoint followed by a normal backend unwind. */
  recordAutonomousStop(): void;
  /** Record that this turn's principal was revoked while work kept running. */
  recordPrincipalRevocation(principalId: string): void;
  /** Record a live follow-up that joined this already-running turn. */
  recordFollowUp(principalId: string): void;
  /** Record who cancelled this turn or an interactive prompt within it. */
  recordCancellation(principalId: string, kind?: "turn" | "ask_user"): void;
  /** Record who answered an ask-user interaction. */
  recordAskUserResponse(principalId: string): void;
  /** Server-authored effect/refusal receipt; worker claims never supply this event. */
  recordApplication?(result: import("@schlessera/brain-ui-sdk/server").BrainApplicationResult): void;
  /**
   * The user's approval decision arrived for a gated tool call. `channel` is
   * how it arrived, when the client said; absent is stored as absent.
   */
  onApprovalDecision(
    toolUseId: string,
    decision: "allow" | "always_allow" | "deny",
    requestKind: "tool" | "command" | "policy",
    principalId?: string,
    channel?: ApprovalChannel
  ): void;
  /**
   * Close the turn: merge the buffered result enrichment into the root's
   * single terminal write, cascade-cancel anything left open, roll up.
   */
  /** Host budget stop outranks the runtime cancellation it caused. */
  recordBudgetStop(reason: string, errorClass?: "budget_exceeded" | "budget_unavailable"): void;
  /** An explicit host failure reason wins over a backend result's message. */
  finish(disposition: "success" | "error" | "cancelled" | "timeout", reason?: string): void;
}

export function createTurnRecorder(
  deps: TurnRecorderDeps,
  turn: {
    lifecycle?: ReturnType<typeof import("./turn-lifecycle.js").createTurnLifecycle>;
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
    /** Server-selected; autonomous attempts never acquire an interactive session. */
    origin?: "session" | "autonomous";
    /** A session turn's posture, for governance attribution. Absent: interactive. */
    posture?: "voice";
    /**
     * The root span's name, when the run is not a conversation turn: the
     * handoff preparation summary (#61) is a run on its source session that
     * Activity names for what it was. Absent means an ordinary turn.
     */
    name?: string;
    /** The worker profile the turn ran under, when the host knows it. */
    profile?: GovernanceProfile | null;
  }
): TurnRecorder {
  const { store, onWrite, log, runtime } = deps;
  const runId = turn.turnId;
  const rootSpanId = `${runId}:turn`;
  let sessionId = turn.sessionId ?? undefined;
  let rootStarted = false;
  let finished = false;
  /** Buffered terminal enrichment from the result frame. */
  let resultOutcome: SpanOutcome | null = null;
  let resultFailureReason: string | undefined;
  let resultUsage: SpanUsage | undefined;
  let mainModel: string | null = null;
  let resultAttrs: Record<string, unknown> | undefined;
  let completedUsage: TurnUsage | undefined;
  let atToolBoundary = false;
  let autonomousStop = false;
  let budgetStop: {reason:string;errorClass:"budget_exceeded" | "budget_unavailable"} | undefined;
  let principalRevocationRecorded = false;
  /** An auth failure was reported: whatever the result frame claims, the run failed. */
  let authFailed = false;
  // What the run's profile requires, once the runtime has reported it: an auth
  // failure on a profile with its own credential is not the subscription's (#254).
  let observedPolicy: BillingMode | undefined;
  // What the run actually billed, as the runtime observed it.
  let observedBilling: string | undefined;
  // What the roadblock classifier reads at finish (#1671): every call as the
  // host saw it, live usage, and how the backend ended the turn.
  const startedAt = Date.now();
  const calls = new Map<string, TracedCall>();
  const usageSamples: UsageSample[] = [];
  let outcomeDetail: string | null = null;
  let cancelledAt: number | null = null;
  let cancelledCallIds: string[] = [];
  let roadblocksRecorded = false;
  const traceCall = (toolUseId: string, toolName?: string): TracedCall | undefined => {
    let call = calls.get(toolUseId);
    if (!call && toolName && calls.size < MAX_TRACED_CALLS) {
      call = { toolCallId: toolUseId, tool: toolName, startedAt: Date.now(), endedAt: null, output: null, isError: false, denied: null };
      calls.set(toolUseId, call);
    }
    return call;
  };
  const traceDenial = (toolUseId: string, reason: string | null) => {
    const call = calls.get(toolUseId);
    if (!call || call.denied || call.output !== null) return;
    call.denied = { reason };
    call.endedAt = Date.now();
  };

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
    turn.lifecycle?.firstFrame(null);
    rootStarted = true;
    store.startSpan({
      spanId: rootSpanId,
      runId,
      name: turn.name ?? SPAN_OP_INVOKE_AGENT,
      kind: "turn",
      origin: turn.origin ?? "session",
      sessionId,
      principalId: turn.principalId,
      // Profile, billing and pricing route ride the ROOT span so the rollup
      // can price the run without any registry or env lookup of its own (a
      // root missing a valid billing attr stays unclassified; a root missing
      // the route prices by model id alone). Server credentials cannot prove
      // the billing or endpoint of the run, so neither field is inferred
      // from the environment.
      attrs: {
        "gen_ai.operation.name": SPAN_OP_INVOKE_AGENT,
        ...(turn.profileId ? { "brain.profile_id": turn.profileId } : {}),
        ...(turn.billingMode ? { "brain.billing_mode": turn.billingMode } : {}),
        ...(turn.pricingRoute ? { "brain.pricing_route": turn.pricingRoute } : {}),
      },
    });
    turn.lifecycle?.linkBackend(runId);
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
    setMainModel(model) { if (!finished) mainModel = model; },
    setWorkerProfile(profile) { turn.profile = profile; },
    runId,

    observeFrame(msg) {
      guard(() => {
        if (finished) return;
        turn.lifecycle?.firstFrame(rootStarted ? runId : null);
        switch (msg.type) {
          case "session_info": {
            sessionId = msg.sessionId;
            turn.lifecycle?.bindSession(msg.sessionId);
            ensureRoot();
            // The root may have been opened before the session had a name.
            store.patchSpan(rootSpanId, { attrs: { "session.id": msg.sessionId } });
            onWrite?.();
            break;
          }
          case "tool_use_start": {
            traceCall(msg.toolUseId, msg.toolName);
            ensureRoot();
            const isSubagent = msg.toolName === "Agent";
            store.startSpan({
              spanId: msg.toolUseId,
              runId,
              parentSpanId: msg.parentToolUseId ?? rootSpanId,
              name: `${SPAN_TOOL_NAME_PREFIX}${msg.toolName}`,
              kind: isSubagent ? "subagent" : "tool",
              origin: turn.origin ?? "session",
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
            const traced = traceCall(msg.toolUseId, msg.toolName);
            if (traced) traced.input = boundedInput(msg.input);
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
            // After the tool returns, the runtime may start another request
            // before any response header/message_start is visible to us.
            atToolBoundary = false;
            const traced = calls.get(msg.toolUseId);
            if (traced && traced.output === null && !traced.denied) {
              traced.output = headAndTail(msg.output);
              traced.isError = msg.isError;
              traced.endedAt = Date.now();
            }
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
            resultFailureReason = msg.failure?.message;
            outcomeDetail = msg.outcomeDetail ?? null;
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
          case "usage":
          case "autonomous_usage": {
            if (event.kind === "autonomous_usage" && turn.origin !== "autonomous") break;
            completedUsage = structuredClone(event.usage);
            atToolBoundary = event.atToolBoundary;
            usageSamples.push({ at: Date.now(), tokens: totalTokens(event.usage), costUsd: event.usage.costUsd ?? null });
            break;
          }
          case "autonomous_identity": {
            ensureRoot();
            store.patchSpan(rootSpanId, { attrs: { "brain.runtime.session_id": event.runtimeSessionId,
              "brain.backend_id": event.backendId } });
            onWrite?.();
            break;
          }
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
          case "runtime_observed": {
            // Observed next to the classification on the root: what ran, the
            // credential it selected, and whether that honours the profile.
            ensureRoot();
            store.patchSpan(rootSpanId, {
              attrs: {
                ...(event.runtime
                  ? { "brain.runtime.name": event.runtime.name, "brain.runtime.version": event.runtime.version }
                  : {}),
                ...(event.sdk ? { "brain.sdk.name": event.sdk.name, "brain.sdk.version": event.sdk.version } : {}),
                ...(event.measured !== undefined ? { "brain.runtime.measured": event.measured } : {}),
                ...(event.credential ? { "brain.credential": event.credential } : {}),
                "brain.billing_observed": event.billing,
                ...(event.policy ? { "brain.billing_policy": event.policy } : {}),
                ...(event.policyViolation ? { "brain.billing_policy_violation": event.policyViolation } : {}),
              },
            });
            if (event.policyViolation) {
              store.appendEvent(rootSpanId, "billing_policy_violation", {
                policy: event.policy,
                observed: event.billing,
                reason: event.policyViolation,
              });
            }
            runtime?.observe(event, runId);
            observedPolicy = event.policy;
            observedBilling = event.billing;
            onWrite?.();
            break;
          }
          case "auth_failure": {
            authFailed = true;
            ensureRoot();
            store.patchSpan(rootSpanId, { attrs: { "brain.failure_class": event.errorClass } });
            store.appendEvent(rootSpanId, "auth_failure", {
              errorClass: event.errorClass,
              ...(event.message ? { message: redactCredentials(event.message) } : {}),
            });
            runtime?.authFailure(event, runId, observedPolicy);
            onWrite?.();
            break;
          }
          case "outward_action":
          case "policy_block":
          case "policy_confirm": {
            ensureRoot();
            store.appendEvent(rootSpanId, event.kind, event.payload);
            try {
              deps.governance?.({ kind: event.kind, payload: event.payload,
                sessionId: sessionId ?? null, turnId: runId,
                actor: turn.origin === "autonomous" ? "autonomous" : turn.posture ?? "interactive",
                model: turn.origin === "autonomous" ? resultUsage?.model ?? null : mainModel, profile: turn.profile ?? (turn.origin === "autonomous" ? "restricted" : null) });
            } catch (error) {
              log?.emit({ severityText: "WARN", body: `governance event not recorded: ${error instanceof Error ? error.message : String(error)}` });
            }
            onWrite?.();
            break;
          }
          case "resource_limit": {
            // A host resource limit stopped a step or the whole worker
            // (#1660): on the run's root span, and as a governance event
            // (#1651) kept with the session after span detail is pruned.
            ensureRoot();
            store.appendEvent(rootSpanId, "worker_resource_limit", { limits: event.limits, fatal: event.fatal });
            if (event.fatal) {
              store.patchSpan(rootSpanId, { attrs: { "brain.failure_class": FIRST_PARTY_FAILURE_CLASSES.worker_resource_limit } });
            }
            if (deps.governance && event.limits.length) {
              try {
                deps.governance({ kind: "resource_limit", payload: { limits: event.limits.slice(0, 20), fatal: event.fatal },
                  sessionId: sessionId ?? null, turnId: runId,
                  actor: turn.origin === "autonomous" ? "autonomous" : turn.posture ?? "interactive",
                  model: null, profile: turn.profile ?? (turn.origin === "autonomous" ? "restricted" : null) });
              } catch (error) {
                // A refused record must not break the turn it describes.
                log?.emit({ severityText: "WARN", body: `governance event not recorded: ${error instanceof Error ? error.message : String(error)}` });
              }
            }
            onWrite?.();
            break;
          }
          case "permission_denied": {
            // The same landing a user's denial gets in requestPermission: the
            // outcome is written now, so the backend's later error tool_result
            // is a write-once no-op and the span reads as denied rather than
            // as a call that failed. The request never reached the host, so
            // there is no principal and no approval_decision event.
            traceDenial(event.toolUseId, event.reason ?? null);
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
        if (turn.lifecycle && !rootStarted) { turn.lifecycle.recordHostEvent("principal_revoked", principalId); principalRevocationRecorded = true; return; }
        ensureRoot();
        store.appendEvent(rootSpanId, "principal_revoked", { principalId });
        principalRevocationRecorded = true;
        onWrite?.();
      });
    },

    recordFollowUp(principalId) {
      guard(() => {
        if (finished) return;
        if (turn.lifecycle && !rootStarted) { turn.lifecycle.recordHostEvent("follow_up", principalId); return; }
        ensureRoot();
        store.appendEvent(rootSpanId, "follow_up", { principalId });
        onWrite?.();
      });
    },

    recordCancellation(principalId, kind = "turn") {
      guard(() => {
        if (finished) return;
        if (turn.lifecycle && !rootStarted) { turn.lifecycle.recordCancellation(principalId, kind); return; }
        ensureRoot();
        if (kind === "turn" && cancelledAt === null) {
          cancelledAt = Date.now();
          cancelledCallIds = [...calls.values()].filter(call => call.endedAt === null).map(call => call.toolCallId);
        }
        store.appendEvent(rootSpanId, `${kind}_cancelled`, { principalId });
        onWrite?.();
      });
    },

    recordApplication(result) {
      guard(() => {
        if (finished) return;
        ensureRoot();
        const applicationId = crypto.randomUUID();
        // Each exact effect stays below the store's per-event cap, even for a
        // 32-file application with maximum-length targets.
        for (const change of result.changes) store.appendEvent(rootSpanId, "brain_application_change", { applicationId, ...change });
        store.appendEvent(rootSpanId, "brain_application", { applicationId, ok: result.ok, code: result.code,
          message: result.message, indexed: result.indexed, changeCount: result.changes.length });
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
          traceDenial(toolUseId, "user declined");
          store.endSpan(toolUseId, { outcome: "denied", reason: "user declined" });
        }
        onWrite?.();
      });
    },

    recordAutonomousStop() { autonomousStop = true; },
    recordBudgetStop(reason,errorClass="budget_exceeded") { budgetStop = {reason,errorClass}; },

    finish(disposition, reason) {
      guard(() => {
        if (finished) return;
        finished = true;
        if (turn.lifecycle && !rootStarted) return;
        ensureRoot();
        // Merged precedence: the buffered result enrichment refines the
        // host's own disposition; the host wins only where the backend said
        // nothing, or explicitly supplies its own failure. Cancellation/timeout
        // are host-owned facts and always win.
        // An auth failure is a failed run even where the runtime's own result
        // frame reports success (the SDK does, with is_error set; #191).
        const outcome: SpanOutcome =
          disposition === "cancelled" || disposition === "timeout"
            ? disposition
            : budgetStop || authFailed || (disposition === "error" && reason !== undefined)
              ? "error"
              : (resultOutcome ?? disposition);
        // A successful autonomous checkpoint can use completed responses;
        // crashes retain its conservative reservation. Ordinary turn errors
        // still retain measured usage when the runtime omits a final receipt.
        if (completedUsage && (autonomousStop && disposition === "cancelled" || turn.origin !== "autonomous" && disposition === "error")) {
          const reportedCost = resultUsage?.costUsd;
          resultUsage = usageFromTurnUsage(completedUsage);
          resultAttrs = { ...resultAttrs, "gen_ai.usage.per_model": completedUsage.perModel,
            "brain.usage.completed_responses": true, "brain.usage.at_tool_boundary": atToolBoundary,
            ...(reportedCost != null ? { "brain.usage.reported_cost_usd": reportedCost } : {}) };
        }
        store.endSpan(rootSpanId, {
          outcome,
          usage: resultUsage,
          attrs: { ...resultAttrs, ...(budgetStop ? {"brain.failure.class":budgetStop.errorClass} : {}) },
          ...((outcome === "error" || outcome === "timeout") && (reason ?? budgetStop?.reason ?? resultFailureReason) !== undefined
            ? { reason: clip((reason ?? budgetStop?.reason ?? resultFailureReason)!, 500) }
            : {}),
        });
        // Anything still open died with the turn.
        store.cascadeClose(runId, "cancelled", `turn ${outcome}`);
        store.rollupRun(runId);
        // Kept now, not only when the status is next read (#254).
        if (outcome === "success" && observedBilling === "subscription") {
          const endedAt = store.getSpan(rootSpanId)?.endedAt;
          if (typeof endedAt === "number") runtime?.subscriptionProven?.(endedAt);
        }
        onWrite?.();
      });
      // Separately guarded: a classification or storage failure loses the
      // roadblock records, never the turn's own Activity write above.
      const governance = deps.governanceDb;
      if (governance && !roadblocksRecorded) {
        roadblocksRecorded = true;
        guard(() => {
          recordTurnRoadblocks(governance, {
            turnId: runId,
            sessionId: sessionId ?? null,
            actor: turn.origin === "autonomous" ? "autonomous" : turn.posture ?? "interactive",
            model: turn.origin === "autonomous" ? resultUsage?.model ?? null : mainModel,
            profile: turn.profile ?? (turn.origin === "autonomous" ? "restricted" : null),
          }, {
            startedAt,
            endedAt: Date.now(),
            calls: [...calls.values()],
            usage: usageSamples,
            finalUsage: turn.origin !== "autonomous" && completedUsage
              ? {tokens:totalTokens(completedUsage),costUsd:completedUsage.costUsd ?? null}
              : resultUsage ? { tokens: totalTokens(resultUsage), costUsd: resultUsage.costUsd ?? null } : null,
            outcomeDetail,
            cancelledAt,
            cancelledCallIds,
          });
        });
      }
    },
  };
}

/** Calls traced per turn for roadblock classification; later calls are not classified. */
const MAX_TRACED_CALLS = 2000;

/**
 * What the classifier needs of a tool input, bounded: the command or target
 * and enough text to tell a retry from a new attempt, never a whole written
 * file held until turn end.
 */
function boundedInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input ?? {}).sort().slice(0, 16)) {
    const value = input[key];
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? value : safeStringify(value);
    // A command keeps its head and tail, where its program and its output
    // target (`> /tmp/x`) are; other text keeps enough to tell attempts apart.
    out[key] = typeof text !== "string" ? text
      : key === "command" && text.length > 5120 ? `${text.slice(0, 4096)}\n${text.slice(-1024)}`
        : key !== "command" && text.length > 1024 ? text.slice(0, 1024) : text;
  }
  return out;
}

/** Enough of a result to classify it: errors print early, exit lines print last. */
function headAndTail(text: string): string {
  return text.length > 6144 ? `${text.slice(0, 4096)}\n...\n${text.slice(-2048)}` : text;
}

/** All tokens of the usage, or null when it reported none. */
function totalTokens(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }): number | null {
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens];
  return parts.every((n) => n === undefined) ? null : parts.reduce<number>((sum, n) => sum + (n ?? 0), 0);
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
