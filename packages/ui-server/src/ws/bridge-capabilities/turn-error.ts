import { BackendBusyError, BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { BudgetExceeded, BudgetUnavailable } from "../../brain/turn-budgets.js";
import { JournalCapacityError } from "../../brain/journal-objects.js";
import { JournalStorageUnavailable } from "../../brain/journal-accounting.js";
import { SafetyRecordingUnavailable } from "../../governance/safety-store.js";
import { withTurnScope } from "../frames.js";
import type { RunningTurn } from "../turns.js";
import type { WsHost } from "../host.js";

export function emitTurnError(host: WsHost, turn: RunningTurn, err: unknown): void {
  const correlation = turn.requestId ? { requestId: turn.requestId } : {};
  // startTurn resolves for runtime failures (it emits its own error frame); it
  // only rejects for caller errors. Each rejection is reported server-side
  // too — the frame alone leaves no trace once the browser tab is gone.
  if (err instanceof BudgetExceeded) {
    const budget=host.budgets?.saved(turn.turnId);
    if (budget && turn.sessionId && host.journal) host.sendToClients(withTurnScope({type:"turn_journal",sessionId:turn.sessionId,
      turnId:turn.turnId,journal:{...host.journal.summary(turn.turnId),budget}},turn));
    host.reportTurnFailed("BUDGET_EXCEEDED", turn, err.message);
    host.sendToClients(withTurnScope({ type:"error", code:"BUDGET_EXCEEDED", message:err.message,
      failure:{errorClass:"budget_exceeded",message:err.message,budgetScope:err.observation.scope,...(err.observation.resetAt ? {resetsAt:err.observation.resetAt} : {})},...correlation },turn));
  } else if (err instanceof BudgetUnavailable) {
    host.reportTurnFailed("BUDGET_UNAVAILABLE",turn,err.message);
    host.sendToClients(withTurnScope({type:"error",code:"BUDGET_UNAVAILABLE",message:err.message,
      failure:{errorClass:"budget_unavailable",message:err.message},...correlation},turn));
  } else if (err instanceof JournalCapacityError || err instanceof JournalStorageUnavailable) {
    const errorClass = err instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable";
    const message = err.message;
    host.reportTurnFailed(errorClass.toUpperCase(), turn, message);
    host.sendToClients(withTurnScope({ type: "error", code: errorClass.toUpperCase(), message,
      failure: { errorClass, message }, ...correlation }, turn));
  } else if (err instanceof SafetyRecordingUnavailable) {
    // Refused before delivery (#3812): retryable, and distinct from a refusal
    // by the brain, so the client can say what happened (#3810).
    const errorClass = err.paused ? "safety_recording_paused" : "safety_recording_unavailable";
    host.reportTurnFailed("SAFETY_RECORDING_UNAVAILABLE", turn, err.message);
    host.sendToClients(withTurnScope({ type: "error", code: "SAFETY_RECORDING_UNAVAILABLE", message: err.message,
      failure: { errorClass, message: err.message }, ...correlation }, turn));
  } else if (err instanceof BackendBusyError) {
    host.reportTurnFailed("SESSION_BUSY", turn);
    host.sendToClients(
      withTurnScope(
        { type: "error", code: "SESSION_BUSY", message: "That session already has a running turn.", ...correlation },
        turn
      )
    );
  } else if (err instanceof BackendRequestError) {
    host.reportTurnFailed("BACKEND_REQUEST_ERROR", turn, err.message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_REQUEST_ERROR", message: err.message,
        ...(err instanceof WorkerHostError ? { failure: { errorClass: err.errorClass, message: err.message } } : {}),
        ...correlation }, turn)
    );
  } else {
    const message = err instanceof Error ? err.message : String(err);
    host.reportTurnFailed("BACKEND_ERROR", turn, message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_ERROR", message, ...correlation }, turn)
    );
  }
}
