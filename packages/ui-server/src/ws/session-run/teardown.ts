import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isEnvName, PROTECTED_TIER_A } from "@schlessera/brain-ui-sdk/internal";
import { prepareClientTurnReceipt } from "../client-turn-receipts.js";
import { withTurnScope } from "../frames.js";
import type { TurnOutcome } from "./outcome.js";
import { releaseActive } from "./slot.js";
import type { TurnRun } from "./types.js";

/**
 * Release everything a turn held, in the order its invariants need: relay
 * and egress stop and settle (the session's next turn reads those hosts back
 * as contacted, G6); the worktree generation retires before the journal's
 * final observation, so no grant follows it; the observation precedes
 * quarantine and gate release; and the recorder's terminal commits before
 * the slot reports its status. Never throws for a release that can fail on
 * its own; those are logged and recovered at startup.
 */
export async function teardownTurn(run: TurnRun, outcome: TurnOutcome): Promise<void> {
  const { host, slot, turn, current, lifecycle, timeoutHandle, recorder, failureRecording, held } = run;
  try {
    const { governedHold, worktreeGeneration } = held;
    const work = current.work;
    const egressEnd = held.providerRelay || held.turnEgress ? lifecycle?.timer("closing")("egress_settle") : undefined;
    await held.providerRelay?.stop();
    held.turnEgress?.stop();
    // The session's next turn reads these hosts back as contacted (G6).
    await held.turnEgress?.settled();
    try { if (!held.turnEgress?.recordingFailure()) egressEnd?.(); } catch { /* A missing timing mark cannot fail cleanup. */ }
    await host.activity?.governanceWrites?.safetyEnd(turn.turnId).catch(error=>host.log.emit({severityText:"ERROR",body:`safety collection finalization failed: ${String(error)}`}));
    host.dialogue.retireTurn(turn.turnId);
    if (held.referenceTurn) host.referenceTools?.end(turn.turnId);
    const budgetFailure = run.stops.budget;
    // External compute (#3108, ruling R7): a cancelled, timed-out,
    // budget-stopped or revoked turn cancels the jobs it started; a turn
    // that ended normally leaves them to the host driver, so a later turn
    // of the conversation can collect them. Not awaited: release is bounded
    // by each provider call, and the turn's end must not wait on a vendor.
    if (host.computeTools) {
      if (run.abortController.signal.aborted || turn.cancelled || outcome.revoked) {
        const reason = turn.cancelled ? "the turn was cancelled" : outcome.revoked ? "the turn's authority was revoked"
          : budgetFailure ? "the turn's budget stopped it" : "the turn was stopped";
        void host.computeTools.cancelTurn(turn.turnId, reason).catch(error => host.log.emit({ severityText: "ERROR", body: `compute jobs of a stopped turn were not cancelled: ${String(error)}` }));
      } else host.computeTools.endTurn(turn.turnId);
    }
    // Apify (#3162): a cancelled, timed-out or budget-stopped turn aborts the
    // runs it started, off the turn's path; a finished turn leaves them for
    // later status reads in its conversation.
    if (host.apify && (turn.cancelled || run.abortController.signal.aborted || budgetFailure))
      void host.apify.stop({ turnId: turn.turnId, sessionId: turn.sessionId }, budgetFailure ? "budget_exhausted" : turn.cancelled ? "cancelled" : "timeout");
    // No grant after this point: the final observation covers everything granted.
    if (worktreeGeneration) await host.referenceWorktrees!.retireGeneration(worktreeGeneration.id).catch(() => {});
    const journalEnd = host.journal ? lifecycle?.timer("closing")("journal_finish") : undefined;
    try {
      // Observe after backend writers stop, before quarantine and gate release.
      await host.journal?.finish(turn.turnId, lifecycle?.timer("closing"));
      journalEnd?.();
    } catch (error) { host.log.emit({ severityText: "ERROR", body: `journal final observation failed: ${String(error)}` }); }
    if (worktreeGeneration) {
      const generationEnd = lifecycle?.timer("closing")("worktree_generation_close");
      // Its workers exited and the final observation is recorded: park what it held.
      host.referenceWorktreeGenerations.delete(turn.turnId);
      try { await host.referenceWorktrees!.closeGeneration(worktreeGeneration.id); await host.referenceWorktrees!.reconcile(); generationEnd?.(); }
      catch (error) { host.log.emit({ severityText: "ERROR", body: `managed worktree generation close failed; startup recovery retries it: ${String(error)}` }); }
    }
    if (host.scope) {
      const scopeEnd = lifecycle?.timer("closing")("scope_finish");
      // The original close does not await these writes. Confirm only an actual
      // settlement before the lifecycle terminal; otherwise the step stays open.
      void host.scope.finish(turn.turnId).then(complete => { if (complete) scopeEnd?.(); }, () => {});
    }
    const reconcileEnd = governedHold ? lifecycle?.timer("closing")("governed_reconcile") : undefined;
    try {
      const reconciled = await governedHold?.end();
      for (const item of reconciled?.quarantined ?? []) {
        const info = lstatSync(item.to);
        host.activity?.governance?.({ kind: "quarantine", payload: { path: item.path,
          tier: isEnvName(item.path) || PROTECTED_TIER_A.includes(item.path as never) ? "A" : "B",
          entry: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other",
          bytes: info.isFile() ? info.size : null, trigger: "turn_end", objectId: createHash("sha256").update(item.to).digest("hex") },
          turnId: turn.turnId, sessionId: turn.sessionId, actor: run.origin, model: run.mainModel,
          profile: governedHold?.sandbox.profile ?? "strict" });
      }
      reconcileEnd?.();
    }
    catch (error) { host.log.emit({ severityText: "ERROR", body: `governed reconciliation failed: ${String(error)}` }); }
    if (governedHold?.sandbox.profile === "governed") host.governedTurns?.refresh(host.workerLock, turn.turnId);
    // The recorder has written the terminal: from here on the Activity
    // record, not this slot, answers for the request (#964).
    await host.inboxTools?.shares?.end(turn.turnId);
    turn.shareId = undefined;
    host.budgets?.end(turn.turnId);
    turn.revision = undefined;
    turn.startedAt = undefined;
    turn.backendStarted = false;
    const failureEnd = lifecycle?.timer("closing")("failure_recording");
    if (await failureRecording.finish(turn.sessionId)) failureEnd?.();
    lifecycle?.finish(outcome.lifecycle, outcome.reason ?? null);
    run.clientReceiptEligible = !!lifecycle && prepareClientTurnReceipt(host, run.turnId, current.principalId, lifecycle.settled);
    clearTimeout(timeoutHandle);
    turn.recorder = undefined;
    work?.settle(outcome.work, { sessionId: turn.sessionId, ...(outcome.reason ? { reason: outcome.reason } : {}) });
    turn.work = undefined;
    releaseActive(slot);
    // The recorder's writes, terminal included, commit off the event loop
    // (#2814); recovery must see them before the final idle notification,
    // which the slot publishes with {@link publishTurnStatus}.
    if (recorder) { await recorder.settled(); lifecycle?.mark("recorderSettledAt"); }
  } finally { host.journal?.evidence?.(turn.turnId); }
}

/**
 * The slot's status once a turn has settled. No backend existed to publish
 * its usual cancelled status, so a turn cancelled before it started is
 * reported here, after native preparation and host cleanup. Otherwise a
 * backend result can precede asynchronous journal finalization, so recovery
 * reads the committed terminal from `idle`, before a successor starts.
 */
export function publishTurnStatus(run: Pick<TurnRun, "host" | "turn" | "clientReceiptEligible">, outcome: Pick<TurnOutcome, "cancelledBeforeStart">): void {
  const { host, turn } = run;
  if (outcome.cancelledBeforeStart) host.sendToClients(withTurnScope({ type: "status", status: "cancelled",
    detail: "Cancelled before starting", ...(turn.requestId ? { requestId: turn.requestId } : {}) }, turn));
  else if (turn.sessionId) {
    // The marker describes completed host cleanup, not a database commit.
    // Eligibility was captured in memory; idle never reads lifecycle storage.
    host.sendToClients(withTurnScope({ type: "status", status: "idle", ...(run.clientReceiptEligible ? { hostTurnComplete: true as const } : {}) }, turn));
  }
}
