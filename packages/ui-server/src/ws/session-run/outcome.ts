import type { ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";
import { BudgetExceeded, BudgetUnavailable } from "../../brain/turn-budgets.js";
import { REVOKED_REASON, type HostWorkOutcome, type RunningTurn } from "../turns.js";
import type { TurnStops } from "./types.js";

/** The terminal a turn's recorder writes; cancellation and timeout are host-owned facts. */
export type RecorderDisposition = "success" | "error" | "cancelled" | "timeout";

/** How a turn ended, for its lifecycle span and its host work item. */
export interface TurnOutcome {
  readonly lifecycle: ActivitySpanOutcome;
  readonly work: HostWorkOutcome;
  readonly reason?: string;
  /** No backend ran, so the slot publishes the cancelled status itself. */
  readonly cancelledBeforeStart: boolean;
}

/** What teardown records when classification itself never ran. */
export const UNCLASSIFIED_OUTCOME: TurnOutcome = { lifecycle: "error", work: "error", cancelledBeforeStart: false };

/**
 * Native admission awaits can outlive principal revocation or expiry. The
 * request is refused without cancelling another principal's queue; this is
 * the error that carries that refusal to failure classification.
 */
export class AdmissionRevoked extends Error {
  constructor() {
    super(REVOKED_REASON);
  }
}

/** The host facts a turn's outcome is read from, sampled once it has stopped. */
export interface TurnFacts {
  readonly cancelled: boolean;
  readonly aborted: boolean;
  readonly lastResult: RunningTurn["lastResult"];
  readonly stops: TurnStops;
}

export type CompletedTurn = TurnOutcome & {
  readonly recorder: RecorderDisposition;
  /** The backend resolved but reported a runtime failure on its result frame. */
  readonly resultFailed: boolean;
};

/**
 * Classify a turn whose backend call resolved. A resolved startTurn is not a
 * successful turn: backends resolve for runtime failures and report them on
 * the terminal result frame, which the bridge recorded on the turn. A host
 * timeout ends the turn like a cancel: its late result is never narrated, and
 * the receipt keeps the reason.
 */
export function classifyCompletedTurn(facts: TurnFacts): CompletedTurn {
  const { cancelled, aborted, lastResult, stops } = facts;
  const work: HostWorkOutcome = cancelled || aborted || lastResult === "cancelled"
    ? "cancelled"
    : lastResult === "error"
      ? "error"
      : "completed";
  const reason = stops.scope ? stops.scope : aborted && !cancelled ? "Turn timed out" : undefined;
  // Terminal precedence: cancellation and timeout are host-owned facts;
  // otherwise the recorder refines from the buffered result frame.
  const recorder: RecorderDisposition = cancelled ? "cancelled" : aborted ? "timeout" : lastResult === "error" ? "error" : "success";
  return {
    lifecycle: recorder,
    work,
    ...(reason !== undefined ? { reason } : {}),
    cancelledBeforeStart: false,
    recorder,
    resultFailed: lastResult === "error",
  };
}

export interface FailedTurnFacts extends TurnFacts {
  readonly error: unknown;
  readonly egressFailure: Error | undefined;
  readonly enteredBackend: boolean;
}

/**
 * How a failed turn is reported to clients:
 *
 * - `cancelled_before_start`: cancelled or revoked during admission with no
 *   other failure; no error frame, and the slot publishes `cancelled`.
 * - `scope_stopped`: a scope cap already narrated why it stopped the turn.
 * - `reported`: the terminal is emitted as an error frame.
 */
export type FailedTurnDelivery = "cancelled_before_start" | "scope_stopped" | "reported";

export type FailedTurn = TurnOutcome & {
  readonly delivery: FailedTurnDelivery;
  readonly recorder: RecorderDisposition;
  /** What the turn ended on: an asynchronous stop wins over the error that unwound it. */
  readonly terminal: unknown;
  /** Admission refused the turn on a budget block, which Activity records as denied. */
  readonly admissionBlock: BudgetExceeded | undefined;
  readonly budgetUnavailable: boolean;
};

/** Classify a turn whose admission or backend call threw. */
export function classifyFailedTurn(facts: FailedTurnFacts): FailedTurn {
  const { cancelled, aborted, stops, egressFailure, enteredBackend, error } = facts;
  const budget = stops.budget, journal = stops.journal, scope = stops.scope;
  const revoked = error instanceof AdmissionRevoked;
  const terminal = budget ?? journal ?? egressFailure ?? error;
  const admissionBlock = terminal instanceof BudgetExceeded && terminal.stage === "admission" ? terminal : undefined;
  const cancelledBeforeStart = !enteredBackend && (cancelled || revoked) && !budget && !journal && !egressFailure && !scope;
  const delivery: FailedTurnDelivery = cancelledBeforeStart
    ? "cancelled_before_start"
    : !scope || budget || journal || egressFailure ? "reported" : "scope_stopped";
  const recorder: RecorderDisposition = budget ? "error" : cancelled || revoked ? "cancelled" : journal || egressFailure ? "error" : aborted ? "timeout" : "error";
  // A host timeout is host-terminal like a cancel: its late result is
  // never narrated (the work keeps the reason).
  const work: HostWorkOutcome = budget ? "error" : cancelled || revoked || !journal && !egressFailure && aborted ? "cancelled" : "error";
  const reason = !cancelled && !budget && !journal && !egressFailure && aborted
    ? "Turn timed out"
    : terminal instanceof Error ? terminal.message : String(terminal);
  return {
    lifecycle: admissionBlock ? "denied" : recorder,
    work,
    reason,
    cancelledBeforeStart,
    delivery,
    recorder,
    terminal,
    admissionBlock,
    budgetUnavailable: terminal instanceof BudgetUnavailable,
  };
}
