import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isEnvName, PROTECTED_TIER_A } from "@schlessera/brain-ui-sdk/internal";
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
  const { governedHold, worktreeGeneration } = held;
  const work = current.work;
  await held.providerRelay?.stop();
  held.turnEgress?.stop();
  // The session's next turn reads these hosts back as contacted (G6).
  await held.turnEgress?.settled();
  host.dialogue.retireTurn(turn.turnId);
  if (held.referenceTurn) host.referenceTools?.end(turn.turnId);
  // No grant after this point: the final observation covers everything granted.
  if (worktreeGeneration) await host.referenceWorktrees!.retireGeneration(worktreeGeneration.id).catch(() => {});
  try {
    // Observe after backend writers stop, before quarantine and gate release.
    await host.journal?.finish(turn.turnId);
  } catch (error) { host.log.emit({ severityText: "ERROR", body: `journal final observation failed: ${String(error)}` }); }
  if (worktreeGeneration) {
    // Its workers exited and the final observation is recorded: park what it held.
    host.referenceWorktreeGenerations.delete(turn.turnId);
    try { await host.referenceWorktrees!.closeGeneration(worktreeGeneration.id); await host.referenceWorktrees!.reconcile(); }
    catch (error) { host.log.emit({ severityText: "ERROR", body: `managed worktree generation close failed; startup recovery retries it: ${String(error)}` }); }
  }
  host.scope?.finish(turn.turnId);
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
  }
  catch (error) { host.log.emit({ severityText: "ERROR", body: `governed reconciliation failed: ${String(error)}` }); }
  if (governedHold?.sandbox.profile === "governed") host.governedTurns?.refresh(host.workerLock);
  // The recorder has written the terminal: from here on the Activity
  // record, not this slot, answers for the request (#964).
  await host.inboxTools?.shares?.end(turn.turnId);
  turn.shareId = undefined;
  host.budgets?.end(turn.turnId);
  turn.revision = undefined;
  turn.startedAt = undefined;
  turn.backendStarted = false;
  await failureRecording.finish(turn.sessionId);
  lifecycle?.finish(outcome.lifecycle, outcome.reason ?? null);
  clearTimeout(timeoutHandle);
  turn.recorder = undefined;
  work?.settle(outcome.work, { sessionId: turn.sessionId, ...(outcome.reason ? { reason: outcome.reason } : {}) });
  turn.work = undefined;
  releaseActive(slot);
  // The recorder's writes, terminal included, commit off the event loop
  // (#2814); recovery must see them before the final idle notification,
  // which the slot publishes with {@link publishTurnStatus}.
  await recorder?.settled();
}

/**
 * The slot's status once a turn has settled. No backend existed to publish
 * its usual cancelled status, so a turn cancelled before it started is
 * reported here, after native preparation and host cleanup. Otherwise a
 * backend result can precede asynchronous journal finalization, so recovery
 * reads the committed terminal from `idle`, before a successor starts.
 */
export function publishTurnStatus(run: Pick<TurnRun, "host" | "turn">, outcome: Pick<TurnOutcome, "cancelledBeforeStart">): void {
  const { host, turn } = run;
  if (outcome.cancelledBeforeStart) host.sendToClients(withTurnScope({ type: "status", status: "cancelled",
    detail: "Cancelled before starting", ...(turn.requestId ? { requestId: turn.requestId } : {}) }, turn));
  else if (turn.sessionId) host.sendToClients(withTurnScope({ type: "status", status: "idle" }, turn));
}
