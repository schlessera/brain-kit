import { emitTurnError } from "../bridge.js";
import { hostStopOf } from "../host-stop.js";
import type { QueuedFollowUp } from "../turns.js";
import { recordPendingCancellations } from "./cancellations.js";
import { admitGovernedTurn, admitWorkerHost, announceTurnStart, armTurnTimeout, confirmAdmission, createRunRecorder } from "./admission.js";
import { openTurnBridge, prepareRelayedEgress, turnRequest } from "./backend-entry.js";
import { outputSpeedBilling, resolveRunBilling } from "./billing.js";
import { budgetAttribution, budgetEvent, createTurnBudget, settleBudgetWrites } from "./budget.js";
import { AdmissionRevoked, classifyCompletedTurn, classifyFailedTurn, UNCLASSIFIED_OUTCOME, type TurnOutcome } from "./outcome.js";
import { teardownTurn } from "./teardown.js";
import type { SessionSlot, TurnLifecycle, TurnRun } from "./types.js";

/**
 * How one request of a slot ended: it `ran` (whatever its outcome), its
 * principal was `revoked` before it reached admission, or the host check
 * `denied` it and the slot stops. The slot acts on each in the same
 * synchronous run as its next dequeue or its close.
 */
type SlotTurnResult =
  | { readonly kind: "ran"; readonly outcome: TurnOutcome; readonly clientReceiptEligible?: boolean }
  | { readonly kind: "revoked" }
  | { readonly kind: "denied"; readonly error: unknown };

/** Run the request the slot is bound to as one turn, from host admission to teardown. */
export async function runSlotTurn(slot: SessionSlot, current: QueuedFollowUp, lifecycle: TurnLifecycle | undefined): Promise<SlotTurnResult> {
  const { host, turn, backend } = slot;
  const work = current.work;
  // The turn's own controller exists before the host check is awaited, so
  // a cancel accepted while the probe runs (#2416) aborts this turn's
  // admission, as one accepted during billing does.
  const abortController = new AbortController();
  turn.abortController = abortController;
  const workerHost = await admitWorkerHost(host, backend, work, turn.outputSpeed);
  if (workerHost.kind === "denied") return { kind: "denied", error: workerHost.error };
  const timeoutHandle = armTurnTimeout(host, turn, abortController);
  const billing = outputSpeedBilling(await resolveRunBilling(host.registry, backend.id, slot.profileId), turn.outputSpeed);
  const failureRecording = await host.failureReplay.begin(backend, slot.resumeId, turn.turnId, abortController.signal);
  // Revocation can land while routing or billing is in flight. This is the
  // final await boundary before startTurn, so an invalid principal never
  // reaches the backend while an already-running turn remains untouched.
  // Expiry is authoritative, not advisory: the sweep that turns an expired
  // principal into a revocation runs on a timer, and a follow-up dequeued
  // inside that window would otherwise start — reviewer measured one
  // starting 12ms past expiry — and then survive, because a started turn is
  // deliberately never aborted. Enforce it at the same boundary that
  // enforces revocation, so the timer only has to close the socket.
  host.expireAuthorizationContexts();
  if (!turn.authorization.valid) {
    lifecycle?.stopAdmission();
    host.budgets?.end(turn.turnId);
    turn.revision = undefined;
    const failureEnd = lifecycle?.timer("closing", {}, { lateEnd: true })("failure_recording");
    await failureRecording.finish(undefined, () => failureEnd?.());
    clearTimeout(timeoutHandle);
    // A cancellation accepted while billing was in flight is already a
    // decision someone made; losing it because the turn's own principal
    // was revoked a moment later would erase the actor, not the turn. Drain
    // the buffer before leaving.
    recordPendingCancellations(host, turn, billing, lifecycle);
    return { kind: "revoked" };
  }
  const recorder = createRunRecorder(host, turn, lifecycle, billing, abortController, work);
  const mainModel = billing?.model ?? null;
  if (mainModel) recorder?.setMainModel(mainModel);
  turn.recorder = recorder;
  for (const principalId of turn.pendingCancellationPrincipalIds) recorder?.recordCancellation(principalId);
  turn.pendingCancellationPrincipalIds.length = 0;
  // A follow-up the backend refused had its source recorded when it was
  // first handed over (#1063).
  turn.retryRequest = {
    type: "chat_message", text: current.text, attachments: current.attachments,
    ...(current.files?.length ? { files: current.files.map(file => ({ kind: "file" as const, path: file.path })) } : {}),
    ...(current.attachmentFiles?.length ? { attachmentRefs: current.attachmentFiles.map(file => ({ kind: "attachment" as const, fileId: file.fileId })) } : {}),
    ...(slot.profileId ? { providerId: slot.profileId } : {}),
    ...(current.client ? { client: current.client } : {}), ...(current.source ? { source: current.source } : {}),
    ...(current.thinkingLevel !== undefined ? { thinkingLevel: current.thinkingLevel } : {}),
    ...(current.requestId ? { requestId: current.requestId } : {}),
  };
  turn.isManualRetry = slot.initial.isRetry === true && turn.turnId === slot.firstTurnId;
  const run: TurnRun = {
    slot, host, turn, backend, current, turnId: turn.turnId, lifecycle, abortController, timeoutHandle, billing,
    failureRecording, recorder, workerIdentity: workerHost.identity, origin: work?.posture === "voice" ? "voice" : "interactive",
    profileId: slot.profileId, resumeId: slot.resumeId, startedAt: Date.now(), mainModel,
    stops: {}, budgetWrites: new Set(), held: { referenceViews: null, referenceTurn: false, enteredBackend: false },
  };
  announceTurnStart(slot, current, run.startedAt);
  return { kind: "ran", outcome: await executeTurn(run), ...(run.clientReceiptEligible ? { clientReceiptEligible: true } : {}) };
}

/** Who ended an aborted turn, sampled once it has stopped. */
function abortFacts({ turn, turnId, abortController }: TurnRun) {
  return { cancelled: turn.cancelled, aborted: abortController.signal.aborted,
    timedOut: turn.timedOutTurnId === turnId, hostStop: hostStopOf(turn, turnId) };
}

/** Admit, enter the backend, classify the outcome and tear the turn down. */
async function executeTurn(run: TurnRun): Promise<TurnOutcome> {
  const { host, turn, backend, lifecycle, recorder, held, stops } = run;
  let outcome: TurnOutcome = UNCLASSIFIED_OUTCOME;
  turn.backendStarted = false;
  try {
    const admission = await admitGovernedTurn(run);
    if (confirmAdmission(run) === "revoked") throw new AdmissionRevoked();
    const budget = host.budgets && held.governedHold ? createTurnBudget(run) : undefined;
    const { prompt, bridge } = await openTurnBridge(run, admission, budget);
    await prepareRelayedEgress(run, bridge, budget);
    held.enteredBackend = true;
    turn.backendStarted = true;
    lifecycle?.mark("backendInvokedAt");
    try { await backend.startTurn(turnRequest(run, prompt, bridge)); }
    finally { lifecycle?.backendExit(); }
    turn.backendStarted = false;
    await held.settleIndex?.();
    // Every relayed attempt reports before the turn's accounting closes.
    const egressEnd = held.providerRelay || held.turnEgress ? lifecycle?.timer("closing")("egress_settle") : undefined;
    await held.providerRelay?.stop();
    held.turnEgress?.stop();
    // Every egress record commits, or fails the turn, before its outcome (#2850).
    await held.turnEgress?.settled();
    try { if (!held.turnEgress?.recordingFailure()) egressEnd?.(); } catch { /* A missing timing mark cannot fail cleanup. */ }
    const egressFailure = held.turnEgress?.recordingFailure();
    if (egressFailure) throw egressFailure;
    // Final observation is part of this host outcome, after worker writes
    // stop and before its Activity terminal, quarantine or gate release.
    // A worktree generation retires first: no grant can follow that observation.
    if (held.worktreeGeneration) await host.referenceWorktrees!.retireGeneration(held.worktreeGeneration.id);
    const journalEnd = host.journal ? lifecycle?.timer("closing")("journal_finish") : undefined;
    await host.journal?.finish(turn.turnId, lifecycle?.timer("closing"));
    journalEnd?.();
    await settleBudgetWrites(run);
    if (stops.budget) throw stops.budget;
    if (stops.journal) throw stops.journal;
    const completed = classifyCompletedTurn({ ...abortFacts(run), lastResult: turn.lastResult, stops });
    if (completed.resultFailed) host.reportTurnFailed("BACKEND_RESULT_ERROR", turn);
    else host.reportTurnCompleted(turn, Date.now() - run.startedAt);
    outcome = completed;
    // A host stop's reason outranks the runtime's own cancelled result.
    recorder?.finish(completed.recorder, completed.recorderReason);
  } catch (err) {
    lifecycle?.mark("failureObservedAt");
    await held.settleIndex?.();
    const egressEnd = held.turnEgress ? lifecycle?.timer("closing")("egress_settle") : undefined;
    await held.turnEgress?.settled();
    try { if (!held.turnEgress?.recordingFailure()) egressEnd?.(); } catch { /* A missing timing mark cannot fail cleanup. */ }
    await settleBudgetWrites(run);
    const failed = classifyFailedTurn({
      ...abortFacts(run), lastResult: turn.lastResult, stops,
      error: err, egressFailure: held.turnEgress?.recordingFailure(), enteredBackend: held.enteredBackend,
    });
    if (failed.admissionBlock) {
      recorder?.recordBudgetStop(failed.admissionBlock.message);
      host.activity?.governance?.(budgetEvent("budget_block", failed.admissionBlock.observation, budgetAttribution(run), "admission"));
    }
    if (failed.budgetUnavailable) recorder?.recordBudgetStop((failed.terminal as Error).message, "budget_unavailable");
    turn.backendStarted = false;
    if (failed.delivery === "reported") emitTurnError(host, turn, failed.terminal);
    outcome = failed;
    recorder?.finish(failed.recorder, failed.recorderReason);
  } finally {
    await teardownTurn(run, outcome);
  }
  return outcome;
}
