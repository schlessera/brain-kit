/**
 * Every write that resets a per-turn member of the slot at a turn boundary
 * (#4831). Writes that record a fact as it comes into being during a turn
 * (the recorder and abort controller at turn start, the retry request and
 * prompt, admission's timeout handle and start time, the accepted revision,
 * the result frame, a timeout or host stop) stay where that fact is made.
 */
import type { QueuedFollowUp, RunningTurn, TurnFields } from "../turns.js";

/** Every member of {@link TurnFields}, none optional: a cleared one is written as an explicit `undefined`. */
type EveryTurnField = { [K in keyof Required<TurnFields>]: TurnFields[K] };

/**
 * The next request is taken off the queue. It stays pending, as
 * `handingOver`, until its turn reaches the backend (#1002); a queued
 * follow-up is its own turn, with a fresh identity and its own terminal
 * disposition. Every other member is carried as it is, until the boundary
 * that owns it.
 */
export function takeNextRequest(turn: RunningTurn, entry: QueuedFollowUp | null): void {
  if (!entry) { turn.handingOver = undefined; return; }
  const next: EveryTurnField = {
    handingOver: entry,
    turnId: entry.lifecycleTurnId ?? crypto.randomUUID(),
    lastResult: null,
    // Replaced when the request is bound (`bindTurnRequest`). `requestId`
    // also outlives teardown on purpose: `publishTurnStatus` reads it after.
    revision: turn.revision,
    startedAt: turn.startedAt,
    principalId: turn.principalId,
    authorization: turn.authorization,
    requestId: turn.requestId,
    draftRef: turn.draftRef,
    attachmentFileIds: turn.attachmentFileIds,
    work: turn.work,
    // Cleared at teardown.
    shareId: turn.shareId,
    backendStarted: turn.backendStarted,
    recorder: turn.recorder,
    // Assigned at turn start, at admission or by the backend entry.
    abortController: turn.abortController,
    timeoutHandle: turn.timeoutHandle,
    // The previous turn's request and prompt are not this one's (#4982).
    retryRequest: undefined,
    retryPrompt: undefined,
    isManualRetry: turn.isManualRetry,
    // Keyed by turn id: a reader compares the id, so a stale value never applies to this turn.
    timedOutTurnId: turn.timedOutTurnId,
    hostStop: turn.hostStop,
  };
  for (const key of Object.keys(next) as Array<keyof TurnFields>) {
    if (!Object.is(turn[key], next[key])) (turn as TurnFields)[key] = next[key] as never;
  }
}

/**
 * A request is bound to the slot. A request whose principal is no longer
 * valid keeps the slot's request fields; the caller releases it
 * (`releaseRevokedRequest`).
 */
export function bindTurnRequest(turn: RunningTurn, current: QueuedFollowUp): void {
  turn.revision = current.revision;
  turn.startedAt = undefined;
  turn.principalId = current.principalId;
  turn.authorization = current.authorization;
  if (!turn.authorization.valid) return;
  turn.requestId = current.requestId;
  turn.draftRef = current.draftRef;
  turn.attachmentFileIds = current.attachmentFiles?.map((f) => f.fileId);
  turn.work = current.work;
}

/** A request is released as revoked, at binding or at the last boundary before the backend: the slot no longer claims its revision. */
export function releaseRevokedRequest(turn: RunningTurn): void {
  turn.revision = undefined;
}

/** Teardown, once the turn's share has ended. */
export function teardownShare(turn: RunningTurn): void {
  turn.shareId = undefined;
}

/** Teardown, once the turn's budget has ended and before its failure recording finishes. */
export function teardownAdmission(turn: RunningTurn): void {
  turn.revision = undefined;
  turn.startedAt = undefined;
  turn.backendStarted = false;
}

/** Teardown, once the failure recording has finished and the timeout is cleared. */
export function teardownRecorder(turn: RunningTurn): void {
  turn.recorder = undefined;
}

/** Teardown, once the turn's work has settled. */
export function teardownWork(turn: RunningTurn): void {
  turn.work = undefined;
}
