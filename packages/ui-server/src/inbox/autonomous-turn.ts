/**
 * Concrete headless turn plumbing. No route, timer or drain dispatches it.
 * Containment/admission/budgets and full-system verification remain gates on
 * production dispatch. U7 supplies the synchronous atomic escalation writer.
 */
import type { Database } from "bun:sqlite";
import type { AgentBackend, BackendBridge, PermissionRequest, ServerMessage,
  StartTurnRequest, AskUserQuestion, BillingMode, PricingRoute, CompletedAutonomousToolCall } from "@schlessera/brain-ui-sdk/server";
import { acquireInboxBudgetRun } from "./budget.js";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createTurnRecorder, type TurnRecorderDeps } from "../activity/recorder.js";
import { checkpointYield, completedCallsForRun, recordCompletedCall, finishYield } from "./yield.js";

export type AutonomousEscalation = {
  runId: string;
  principalId: string;
  /** Model-authored data, capped at 4096 UTF-8 bytes; never authority. */
  stateMd: string;
} & ({ kind: "permission"; request: PermissionRequest } |
  { kind: "question"; requestId: string; questions: AskUserQuestion[] });

export interface AutonomousTurnInput {
  turnId: string;
  principalId: string;
  prompt: string;
  profileId?: string;
  billingMode?: BillingMode;
  pricingRoute?: PricingRoute;
  allowedTools: readonly string[];
  systemPromptAppend: string;
  signal: AbortSignal;
  yieldAfterMs?: number;
}

export interface AutonomousTurnDeps extends TurnRecorderDeps {
  db: Database;
  backend: AgentBackend;
  /** Must commit checkpoint + Action/block intent synchronously or throw. */
  checkpoint(escalation: AutonomousEscalation): void;
  /** Internal frame observer, not a WebSocket or session catalog. */
  emit?(frame: ServerMessage): void;
}

export interface AutonomousTurnResult {
  runId: string;
  outcome: "success" | "error" | "cancelled";
  escalated: boolean;
  yielded: boolean;
}

/** Called only with authority selected by server code, never a parsed client/model payload. */
export async function runAutonomousTurn(
  deps: AutonomousTurnDeps,
  input: AutonomousTurnInput
): Promise<AutonomousTurnResult> {
  if (deps.backend.capabilities.autonomous !== true) {
    throw new BackendRequestError(`Backend ${deps.backend.id} does not support autonomous turns.`);
  }
  const principalId = input.principalId;
  const usable = (): boolean => {
    const principal = resolvePrincipal(deps.db, principalId);
    return Boolean(principal && isUsablePrincipal(principal, Date.now()));
  };
  if (!usable()) throw new BackendRequestError("Autonomous principal is missing, expired or revoked.");
  try { acquireInboxBudgetRun(deps.db, input.turnId, principalId); }
  catch (error) { throw new BackendRequestError(error instanceof Error ? error.message : "Autonomous budget admission failed."); }
  // Own immutable request policy for the attempt; callbacks cannot widen it.
  const recorder = createTurnRecorder(deps, { turnId: input.turnId, sessionId: null,
    principalId, origin: "autonomous", profileId: input.profileId,
    billingMode: input.billingMode, pricingRoute: input.pricingRoute });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  let closed = false;
  let escalated = false;
  let revoked = false;
  let failed = false;
  let yielded = false;
  const tools = new Map<string, CompletedAutonomousToolCall>();
  let stateMd = "";
  let outcome: AutonomousTurnResult["outcome"] = "error";
  let terminal = false;
  const checkPrincipal = (): boolean => {
    if (closed || revoked) return false;
    if (usable()) return true;
    revoked = true;
    recorder.recordPrincipalRevocation(principalId);
    controller.abort();
    return false;
  };
  const emit = (frame: ServerMessage): void => {
    if (closed) return;
    checkPrincipal();
    if (frame.type === "session_info") {
      failed = true;
      controller.abort();
      throw new BackendRequestError("An autonomous backend advertised an interactive session.");
    }
    if (frame.type === "text_delta" && !escalated && !controller.signal.aborted) {
      stateMd = clipUtf8(stateMd + frame.text, 4096);
    }
    if (frame.type === "tool_use_complete") tools.set(frame.toolUseId, JSON.parse(JSON.stringify({ toolName: frame.toolName, input: frame.input })) as CompletedAutonomousToolCall);
    if (frame.type === "tool_result") {
      const call = tools.get(frame.toolUseId);
      if (call) { recordCompletedCall(deps.db, input.turnId, frame.toolUseId, call); tools.delete(frame.toolUseId); }
    }
    if (frame.type === "result") {
      if (terminal) return;
      terminal = true;
      outcome = failed ? "error" : controller.signal.aborted ? "cancelled" : frame.outcome ?? (frame.isError ? "error" : "success");
      frame = { ...frame, outcome, isError: outcome === "error" };
    }
    recorder.observeFrame(frame);
    deps.emit?.({ ...frame, turnId: input.turnId } as ServerMessage);
  };
  const mode = Object.freeze({ origin: "autonomous" as const, persistence: "none" as const,
    allowedTools: Object.freeze([...input.allowedTools]), systemPromptAppend: input.systemPromptAppend,
    completedToolCalls: Object.freeze(completedCallsForRun(deps.db, input.turnId)),
    yieldAfterMs: input.yieldAfterMs ?? 20_000,
    onYield: (key: string): void => {
      if (closed || terminal || yielded || escalated || controller.signal.aborted || !checkPrincipal()) return;
      try { checkpointYield(deps.db, input.turnId, key, stateMd); yielded = true; }
      catch { failed = true; emit({ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }); }
      finally { controller.abort(); }
    },
  });
  const checkpoint = (intent: { kind: "permission"; request: PermissionRequest } |
    { kind: "question"; requestId: string; questions: AskUserQuestion[] }): void => {
    if (closed || escalated || controller.signal.aborted || !checkPrincipal()) return;
    // Snapshot exact inputs before invoking server code. Neither a live model
    // object nor an approval Promise survives the checkpoint boundary.
    const snapshot = JSON.parse(JSON.stringify(intent)) as typeof intent;
    try {
      const result: unknown = deps.checkpoint({ ...snapshot, stateMd, runId: input.turnId, principalId });
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Autonomous checkpoint must complete synchronously.");
      }
      escalated = true;
    } catch (error) {
      failed = true;
      emit({ type: "error", code: "AUTONOMOUS_CHECKPOINT_FAILED", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      // Capture/commit first, then abort. No live approval promise is created.
      controller.abort();
    }
  };
  const bridge: BackendBridge = {
    emit,
    activity: (event) => { if (!closed) { checkPrincipal(); recorder.observeActivity(event); } },
    checkpointPermission: (request) => checkpoint({ kind: "permission", request }),
    requestPermission: async (request) => {
      checkpoint({ kind: "permission", request });
      return { behavior: "deny", message: "Autonomous work stopped for a durable decision." };
    },
    askUser: async (requestId, questions) => {
      checkpoint({ kind: "question", requestId, questions });
      throw new Error("Autonomous work stopped for a durable decision.");
    },
  };
  const request: StartTurnRequest = { prompt: input.prompt, profileId: input.profileId,
    signal: controller.signal, bridge, autonomous: mode, enforceAllowedTools: true, noGrantSurface: true };
  const principalCheck = setInterval(checkPrincipal, 100);
  try {
    await deps.backend.startTurn(request);
    if (!terminal) {
      outcome = failed ? "error" : controller.signal.aborted ? "cancelled" : "error";
      // A Claude failure before runtime identity has a bare error terminal.
      if (!controller.signal.aborted && !failed) failed = true;
    }
    return { runId: input.turnId, outcome, escalated, yielded };
  } catch (error) {
    outcome = "error";
    emit({ type: "error", code: "AUTONOMOUS_TURN_FAILED", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    closed = true;
    clearInterval(principalCheck);
    input.signal.removeEventListener("abort", abort);
    recorder.finish(outcome);
    if (yielded) finishYield(deps.db, input.turnId);
  }
}

function clipUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  // Drop an incomplete trailing sequence rather than replacing it with bytes
  // that would make a supposedly bounded checkpoint exceed the limit.
  for (let end = limit; end >= limit - 3; end--) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { /* try the prior boundary */ }
  }
  return "";
}
