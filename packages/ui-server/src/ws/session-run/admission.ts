import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { WorkerNoteFacts } from "@schlessera/brain-ui-sdk/internal";
import { requireWorkerHostRecorded } from "../../agent/worker-host.js";
import { createTurnRecorder, type TurnRecorder } from "../../activity/recorder.js";
import { BudgetExceeded, BudgetUnavailable } from "../../brain/turn-budgets.js";
import { withTurnScope } from "../frames.js";
import type { WsHost } from "../host.js";
import { turnLogAttributes } from "../limits.js";
import type { HostWork, QueuedFollowUp, RunningTurn } from "../turns.js";
import type { RunBilling } from "./billing.js";
import { budgetAttribution, budgetEvent } from "./budget.js";
import type { SessionSlot, TurnLifecycle, TurnRun } from "./types.js";

export type WorkerHostAdmission =
  | { readonly kind: "admitted"; readonly identity: WorkerNoteFacts["identity"] | undefined }
  | { readonly kind: "denied"; readonly error: unknown };

/**
 * The host check every interactive or voice turn repeats, before transcript,
 * source or failure recording and before any runtime initialization.
 */
export async function admitWorkerHost(host: WsHost, backend: AgentBackend, work: HostWork | undefined): Promise<WorkerHostAdmission> {
  try {
    const workerHost = await requireWorkerHostRecorded(host.brainPath ?? process.cwd(), "ordinary", host.activity?.runtime, { identitySentinelDirectory: host.identitySentinelDirectory });
    const identity: WorkerNoteFacts["identity"] | undefined = workerHost?.identity === "separate_uid" && workerHost.workerUid !== undefined
      ? { kind: "separate_uid", workerUid: workerHost.workerUid } : undefined;
    // Pi turn-runner declares no voice tool posture. Keep this early
    // admission refusal aligned with that direct-consumer guard if Pi
    // gains a voice posture, before any native maintenance workers start.
    if (backend.id === "pi" && work?.posture === "voice")
      throw new BackendRequestError("The pi backend declares no voice tool posture; a voice turn cannot run on it.");
    return { kind: "admitted", identity };
  } catch (error) {
    return { kind: "denied", error };
  }
}

/**
 * Arm the host's turn timeout. On expiry the turn aborts, and any pending
 * interactive request for it is rejected too: a bridge that awaits
 * askUser/approval without racing the abort signal would otherwise leave
 * startTurn parked forever after abort(), leaking a concurrency slot until
 * restart. Draining unblocks the unwind.
 */
export function armTurnTimeout(host: WsHost, turn: RunningTurn, abortController: AbortController): ReturnType<typeof setTimeout> {
  const timeoutHandle = setTimeout(() => {
    host.log.emit({
      severityText: "WARN",
      body: "turn timed out",
      // Read from the live turn: session_info may have named the session
      // after this timer was armed.
      attributes: { ...turnLogAttributes(turn), "timeout.ms": host.turnTimeoutMs },
    });
    abortController.abort();
    host.coordinator.drainPendingForTurn(turn, "Turn timed out");
  }, host.turnTimeoutMs);
  turn.timeoutHandle = timeoutHandle;
  return timeoutHandle;
}

/**
 * One recorder per turn identity: a queued follow-up re-mints turnId and gets
 * its own run in the activity record. The recorder is handed the RESOLVED
 * profile — post pin-drop fallback, carrying any session_info re-pin forward
 * between queued turns — plus its billing mode, so the run's root span
 * classifies what actually ran, never what was requested.
 */
export function createRunRecorder(
  host: WsHost,
  turn: RunningTurn,
  lifecycle: TurnLifecycle | undefined,
  billing: RunBilling,
  abortController: AbortController,
  work: HostWork | undefined
): TurnRecorder | undefined {
  return host.activity
    ? createTurnRecorder(
        {
          store: host.activity.store,
          ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
          ...(host.activity.governance ? { governance: host.activity.governance } : {}),
          onWrite: () => host.activity!.stream.pump(),
          log: host.log,
          ...(host.activity.governanceDb ? { governanceDb: host.activity.governanceDb } : {}),
          ...(host.activity.governanceWrites ? { governanceWrites: host.activity.governanceWrites } : {}),
          ...(host.brainPath ? { brainPath: host.brainPath } : {}),
          abort: error => abortController.abort(error),
        },
        {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          principalId: turn.principalId,
          lifecycle,
          ...billing,
          ...(work?.posture === "voice" ? { posture: "voice" as const } : {}),
        }
      )
    : undefined;
}

/**
 * Mark the request as the agent's: recovery reads it as running from here,
 * and it leaves the pending list ahead of every frame of its own turn, so a
 * client can place it in the transcript where it entered the conversation
 * (#1002). A cancel that landed while billing resolved has already reported
 * it dropped.
 */
export function announceTurnStart(slot: SessionSlot, current: QueuedFollowUp, startedAt: number): void {
  const { host, turn, backend, resumeId } = slot;
  // Host admission has started: recovery reads this request as running.
  turn.startedAt = startedAt;
  if (turn.revision !== undefined && resumeId) {
    host.catalog.dispatchWork?.(resumeId, turn.revision, turn.turnId, backend.id, startedAt);
  }
  if (turn.handingOver === current) {
    turn.handingOver = undefined;
    host.coordinator.queueChanged(turn.sessionId, { started: { entry: current, turnId: turn.turnId } });
  }
  host.reportTurnStarted(turn);
  current.work?.started(turn.turnId);
}

/** The worker profile a governed turn records: anything not `governed` runs strict. */
export function heldProfile(run: Pick<TurnRun, "held">): "governed" | "strict" {
  return run.held.governedHold!.sandbox.profile === "governed" ? "governed" : "strict";
}

export type GovernedAdmission =
  | {
      readonly kind: "admitted";
      /** The principal's profile preference for an interactive turn, which a draft's first send records. */
      readonly preference: "governed" | "strict" | undefined;
    }
  | { readonly kind: "revoked" };

/**
 * Governed admission, in order: the governed hold, the budget and its
 * warnings, the journal, a managed worktree generation (#2430), reference
 * tools (#2432) and per-turn scope caps. What it acquires is recorded on
 * {@link TurnRun.held} as it goes, so teardown releases it whichever way the
 * turn ends. Throws a refusal or an abort; resolves `revoked` when the
 * principal lost authority during the native awaits.
 */
export async function admitGovernedTurn(run: TurnRun): Promise<GovernedAdmission> {
  const { host, slot, turn, backend, lifecycle, abortController, billing, recorder, held, stops, origin, profileId, resumeId } = run;
  const { initial } = slot;
  if (initial.profileDraftId && (!initial.draftId || !initial.requestId || initial.sessionId
    || (initial.draftRef && initial.draftRef.draftId !== initial.profileDraftId)))
    throw new Error("A draft profile requires the matching first-send identity and correlation.");
  const preference = origin === "interactive"
    ? host.sessionProfiles?.preference(turn.principalId, resumeId, resumeId ? undefined : initial.profileDraftId) : undefined;
  if (host.governedTurns) lifecycle?.mark("governedStartedAt");
  else lifecycle?.skip("governed");
  // Only a backend whose turn runs on the host inference relay can name
  // the origin that relay forwards to; admission proves the recipient
  // from it, and the relay refuses any other (#2695).
  const inferenceOrigin = host.governedTurns && isRelayed(backend) && backend.inferenceOrigin
    ? await backend.inferenceOrigin({ ...(profileId ? { profileId } : {}), ...(resumeId ? { sessionId: resumeId } : {}) }).catch(() => undefined) : undefined;
  abortController.signal.throwIfAborted();
  const handoffSource = !resumeId && turn.turnId === slot.firstTurnId ? initial.handoffHooks?.sourceSessionId : undefined;
  held.governedHold = await host.governedTurns?.begin(turn.turnId, abortController.signal, origin, preference, {
    ...(inferenceOrigin ? { inferenceOrigin } : {}), ...(resumeId ? { sessionId: resumeId } : {}), ...(handoffSource ? { inherit: [handoffSource] } : {}) });
  const governedHold = held.governedHold;
  if (governedHold) lifecycle?.mark("governedAcquiredAt");
  if (!governedHold || !host.budgets) lifecycle?.skip("budget");
  if (!governedHold || !host.journal) lifecycle?.skip("journal");
  if (governedHold && host.budgets) {
    lifecycle?.mark("budgetStartedAt");
    try { await host.budgets.begin(turn.turnId, resumeId, governedHold.policy.policy, billing?.pricingRoute); }
    catch (error) { if (error instanceof BudgetExceeded) throw error; throw new BudgetUnavailable(); }
  }
  if (governedHold && host.budgets) lifecycle?.mark("budgetAdmittedAt");
  try {
    if (governedHold && host.budgets) for (const item of await host.budgets.warnings(turn.turnId))
      host.activity?.governance?.(budgetEvent("budget_warning", item, budgetAttribution(run)));
  } catch { throw new BudgetUnavailable(); }
  if (governedHold) recorder?.setWorkerProfile(governedHold.sandbox.profile ?? "strict");
  if (governedHold && host.journal) {
    lifecycle?.mark("journalStartedAt");
    await host.journal.begin(turn.turnId, { sessionId: turn.sessionId ?? null,
      actor: origin, model: run.mainModel,
      profile: heldProfile(run), policyHash: governedHold.policy.hash },
    error => {
      // A real timeout/cancel already won; never relabel that terminal.
      if (abortController.signal.aborted || turn.cancelled) return;
      stops.journal = error;
      abortController.abort(error);
      host.coordinator.drainPendingForTurn(turn, error.message);
    }, abortController.signal);
    lifecycle?.mark("journalBeganAt");
  }
  abortController.signal.throwIfAborted();
  // Managed worktrees (#2430): a journaled turn's workers bind one empty generation.
  // A worktree reaches it only through an access that first covers it in this journal.
  if (governedHold && host.journal && host.referenceWorktreeAccess && host.referenceWorktrees && host.journal.summary(turn.turnId).state === "recording") {
    try {
      held.worktreeGeneration = await host.referenceWorktrees.openGeneration({ principalId: turn.principalId, turnId: turn.turnId,
        profile: heldProfile(run), signal: abortController.signal });
      host.referenceWorktreeGenerations.set(turn.turnId, held.worktreeGeneration);
    } catch (error) {
      // The turn runs without worktree access; nothing was granted.
      if (abortController.signal.aborted) throw error;
      host.log.emit({ severityText: "WARN", body: `managed worktree generation unavailable for this turn: ${String(error)}` });
    }
  }
  // Reference tools (#2432): the turn's workers bind the principal's source
  // views and the generation above; the tools report only what they bind.
  if (governedHold && host.referenceTools) {
    held.referenceTurn = true;
    held.referenceViews = await host.referenceTools.begin(turn.turnId, { principalId: turn.principalId, posture: origin,
      generation: held.worktreeGeneration ?? null, signal: abortController.signal });
  }
  if (governedHold && host.scope) await beginTurnScope(run);
  abortController.signal.throwIfAborted();
  // Native admission awaits can outlive principal revocation or expiry.
  host.expireAuthorizationContexts();
  if (!turn.authorization.valid) return { kind: "revoked" };
  return { kind: "admitted", preference };
}

/** Whether the backend's turn runs on the host inference relay. */
export function isRelayed(backend: AgentBackend): boolean {
  return backend.id === "claude" || backend.id === "pi";
}

/**
 * Per-turn scope caps (#1670). A cap stops the turn by narrating its reason
 * as the turn's text, then aborting it like a cancel.
 */
async function beginTurnScope(run: TurnRun): Promise<void> {
  const { host, turn, current, abortController, stops, origin, turnId: scopeTurnId } = run;
  const governedHold = run.held.governedHold!;
  const work = current.work;
  await host.scope!.begin(scopeTurnId, { sessionId: turn.sessionId ?? null, principalId: turn.principalId,
    origin, model: () => run.mainModel, profile: heldProfile(run), policy: governedHold.policy.policy,
    source: governedHold.policy.source === "default" ? "default" : "policy", hardTimeoutMs: host.turnTimeoutMs,
    current: () => turn.turnId === scopeTurnId && !abortController.signal.aborted && current.authorization.valid && current.authorization.expiresAt > Date.now() && host.isPrincipalAuthorized(current.principalId),
    stop: reason => {
      if (turn.turnId !== scopeTurnId || abortController.signal.aborted) return;
      stops.scope = reason; turn.cancelled = true;
      const frame = withTurnScope({ type: "text_delta", text: reason }, turn, turn.turnId);
      host.sendToClients(frame); work?.observe(frame);
      abortController.abort(new Error(reason)); host.coordinator.drainPendingForTurn(turn, reason);
    } });
}
