import { prepareTurnEgress } from "../brain/turn-egress.js";
import { sessionTaint } from "../governance/session-taint.js";
import { createTurnLifecycle } from "../activity/turn-lifecycle.js";
import { BudgetExceeded, BudgetUnavailable, inferenceBudgetLimits, inferenceBudgetContext } from "../brain/turn-budgets.js";
import { withTrackFiles } from "../tracks/read.js";
import type {
  BillingMode,
  ChatImageAttachment,
  ClientEnvironment,
  DraftRef,
  LocalExchange,
  MessageSource,
  PricingRoute,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { linkSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isEnvName, PROTECTED_TIER_A, PROVIDER_RELAY_KEYS_NAME, PROVIDER_RELAY_SOCKET_NAME, heldCustomProviderKeys, startProviderRelay, type ProviderRelay } from "@schlessera/brain-ui-sdk/internal";
import type { BudgetObservation } from "@schlessera/brain-ui-sdk/protocol";
import { requireWorkerHostRecorded } from "../agent/worker-host.js";
import type { BackendRegistry } from "../agent/backend.js";
import type { WSContext } from "./clients.js";
import { withSessionId, withTurnScope } from "./frames.js";
import { makeBridge, emitTurnError, settleTurnIndex } from "./bridge.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { createTurnRecorder, type TurnRecorder } from "../activity/recorder.js";
import { resolveTurnTarget } from "./routing.js";
import { withLocalContext } from "./local-exchanges.js";
import { acceptDraft } from "./drafts.js";
import { acceptRequest } from "./recovery.js";
import type { AuthorizationContext, HostWork, HostWorkOutcome, QueuedFollowUp, RunningTurn } from "./turns.js";
import { queuedBytes, queuedFollowUpBytes, REVOKED_REASON } from "./turns.js";

/** Why a follow-up leaves when its session's slot ends without running it (#1002). */
const SLOT_ENDED_REASON = "The session stopped before it ran.";
import {
  MAX_SESSION_QUEUE,
  QUEUE_MAX_BYTES,
  QUEUE_WARN_BYTES,
  turnLogAttributes,
  type WsHost,
} from "./host.js";

/**
 * Run one session slot: the initial turn, then any queued follow-up turns in
 * order. The host owns per-turn cancellation (AbortController + timeout). Never
 * throws — runtime failures are emitted as error frames.
 */
/**
 * Write out cancellations that were accepted before a recorder existed.
 *
 * A cancel can land while routing or billing is still in flight, when there is
 * nothing to record it on yet, so the actor is buffered on the turn. Both exits
 * from that window have to drain it — the ordinary one, which then has a
 * recorder, and the revoked one, which must build a throwaway recorder rather
 * than drop a decision someone actually made.
 */
function recordPendingCancellations(
  host: WsHost,
  turn: RunningTurn,
  billing: Awaited<ReturnType<typeof resolveRunBilling>> | undefined,
  lifecycle?: ReturnType<typeof createTurnLifecycle>
): void {
  if (turn.pendingCancellationPrincipalIds.length === 0) return;
  if (lifecycle && !turn.recorder) {
    for (const principalId of turn.pendingCancellationPrincipalIds) lifecycle.recordCancellation(principalId);
    turn.pendingCancellationPrincipalIds.length = 0;
    return;
  }
  const recorder =
    turn.recorder ??
    (host.activity
      ? createTurnRecorder(
          {
            store: host.activity.store,
            ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
            ...(host.activity.governance ? { governance: host.activity.governance } : {}),
            onWrite: () => host.activity!.stream.pump(),
            log: host.log,
          },
          {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            principalId: turn.principalId,
            ...billing,
          }
        )
      : undefined);
  for (const principalId of turn.pendingCancellationPrincipalIds) {
    recorder?.recordCancellation(principalId);
  }
  turn.pendingCancellationPrincipalIds.length = 0;
}

type RunSessionInput = {
  shareId?: string;
  authorization: AuthorizationContext;
  replayPrompt?: string;
  isRetry?: boolean;
  text: string;
  sessionId?: string;
  attachments: ChatImageAttachment[];
  files?: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[];
  providerId?: string;
  client?: ClientEnvironment;
  source?: MessageSource;
  thinkingLevel?: ThinkingLevel;
  requestId?: string;
  /** Client correlation id for a new conversation; echoed on session_info. */
  draftId?: string;
  /** The saved draft revision this message was sent from (#979). */
  draftRef?: DraftRef;
  profileDraftId?: string;
  /** Accepted-work revision of this request (#964), for a known session. */
  revision?: number;
  /**
   * Local exchanges the draft conversation holds (#582). Recorded against
   * the session once `session_info` names it, and carried on its first
   * prompt.
   */
  localExchanges?: LocalExchange[];
  /** A handoff destination's hooks (#61); only on a new conversation. */
  handoffHooks?: HandoffHooks;
  /** Host-orchestrated work this message carries (#957). */
  work?: HostWork;
};

/**
 * What a handoff creation (#61) needs from the run that creates its
 * destination: the moment `session_info` names it, and the moment the
 * attempt is over, whichever way it ended.
 */
export interface HandoffHooks {
  /** The conversation handed off: its provider history continues in the destination (#2695). */
  readonly sourceSessionId?: string;
  onNamed(sessionId: string): void;
  onSettled(): void;
}

/**
 * A queue lease that also settles the work it carries. Every queue exit
 * releases its lease exactly once, so a dropped entry's work settles as
 * cancelled; one that ran has already settled with its real outcome.
 */
function leaseFor(authorization: AuthorizationContext, work: HostWork | undefined): () => void {
  const release = authorization.retain();
  if (!work) return release;
  return () => {
    release();
    work.settle("cancelled", { reason: "Removed from the session queue before it ran" });
  };
}

/**
 * Record a new conversation's local exchanges against the session its first
 * turn created, and tell every client whether each one is kept: the client
 * that ran them holds them in a draft that has just become this session.
 */
function recordDraftExchanges(host: WsHost, sessionId: string, exchanges: readonly LocalExchange[]): void {
  for (const exchange of exchanges) {
    const saved = host.catalog.recordLocalExchange?.(sessionId, exchange, true) ?? false;
    host.sendToClients({
      type: "local_exchange_result",
      sessionId,
      exchangeId: exchange.id,
      saved,
      ...(saved ? {} : { reason: "The server could not store it." }),
    });
  }
}

export async function runSession(host: WsHost, initial: RunSessionInput): Promise<void> {
  if (host.closing) throw new Error("The host is shutting down; no new turn was started.");
  const releaseAuthorization = initial.authorization.retain();
  const turnId = crypto.randomUUID();
  const lifecycle = host.activity ? createTurnLifecycle(host.activity.store, turnId, initial.sessionId ?? null, Date.now(), () => host.activity!.stream.pump()) : undefined;
  const task = runRetainedSession(host, initial, turnId, lifecycle);
  host.turnTasks.add(task);
  try {
    await task;
  } catch (error) {
    lifecycle?.finish("error", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    lifecycle?.finish("cancelled", "The session ended before backend entry");
    // Every early exit (cancelled while routing, revoked) lands here; a work
    // item that ran has settled already and ignores this.
    try { initial.work?.settle("cancelled", { reason: "The session ended before this request ran" }); }
    finally {
      try { releaseAuthorization(); }
      finally { try { initial.handoffHooks?.onSettled(); } finally { host.turnTasks.delete(task); } }
    }
  }
}

async function runRetainedSession(
  host: WsHost,
  initial: RunSessionInput,
  initialTurnId: string,
  initialLifecycle: ReturnType<typeof createTurnLifecycle> | undefined
): Promise<void> {
  const { coordinator } = host;
  const starting: { queue: QueuedFollowUp[]; cancelled: boolean; revision?: number } = {
    queue: [],
    cancelled: false,
    ...(initial.revision !== undefined ? { revision: initial.revision } : {}),
  };
  if (initial.sessionId) coordinator.startingBySession.set(initial.sessionId, starting);
  coordinator.startingSessions += 1;
  let target: Awaited<ReturnType<typeof resolveTurnTarget>>;
  try {
    target = await resolveTurnTarget(host.registry, host.catalog, initial.sessionId, initial.providerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    initialLifecycle?.finish("error", message);
    // No turn exists yet — routing failed before one was minted — so the
    // report carries only the session identity the client asked for.
    host.reportTurnFailed("BACKEND_ERROR", { sessionId: initial.sessionId }, message);
    initial.work?.settle("error", { reason: message });
    // Messages queued behind this start have no runner now: settle their
    // work and release their leases instead of stranding them.
    for (const entry of starting.queue) entry.work?.settle("error", { reason: message });
    if (initial.sessionId) coordinator.dropStartingQueue(initial.sessionId, starting, message);
    else for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    host.sendToClients({
      type: "error",
      code: "BACKEND_ERROR",
      message,
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
      ...(initial.requestId ? { requestId: initial.requestId } : {}),
    });
    return;
  } finally {
    coordinator.startingSessions = Math.max(0, coordinator.startingSessions - 1);
    if (initial.sessionId && coordinator.startingBySession.get(initial.sessionId) === starting) {
      coordinator.startingBySession.delete(initial.sessionId);
    }
  }

  if (starting.cancelled || host.closing) {
    for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    return;
  }
  if (!initial.authorization.valid) {
    if (initial.sessionId) coordinator.dropStartingQueue(initial.sessionId, starting, REVOKED_REASON);
    else for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    return;
  }

  const { backend, profileId: initialProfileId } = target;
  if (target.droppedPin) {
    host.log.emit({
      severityText: "WARN",
      body: "pinned profile unavailable; running on the default profile",
      attributes: { "session.id": initial.sessionId, profile: target.droppedPin },
    });
    host.sendToClients({
      type: "status",
      status: "thinking",
      detail: `Pinned model "${target.droppedPin}" is unavailable — running on the default.`,
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
    });
  }
  const turn: RunningTurn = {
    principalId: initial.authorization.principalId,
    authorization: initial.authorization,
    sessionId: initial.sessionId ?? null,
    turnId: initialTurnId,
    // Only meaningful when the client had no session id to send.
    draftId: initial.sessionId ? null : (initial.draftId ?? null),
    providerId: initialProfileId ?? null,
    backend,
    abortController: new AbortController(),
    timeoutHandle: setTimeout(() => {}, 0),
    queue: starting.queue,
    pendingCancellationPrincipalIds: [],
    cancelled: false,
    lastResult: null,
  };
  turn.shareId = initial.shareId;
  const firstTurnId = turn.turnId;
  clearTimeout(turn.timeoutHandle);
  coordinator.running.add(turn);
  if (turn.sessionId) coordinator.bySession.set(turn.sessionId, turn);

  let profileId = initialProfileId;
  let resumeId = initial.sessionId;
  // Only the first turn of a new conversation carries the draft's exchanges.
  let draftExchanges = initial.sessionId ? [] : (initial.localExchanges ?? []);
  let next: QueuedFollowUp | null = {
    principalId: initial.authorization.principalId,
    authorization: initial.authorization,
    text: initial.text,
    attachments: initial.attachments,
    ...(initial.files?.length ? { files: initial.files } : {}),
    ...(initial.client ? { client: initial.client } : {}),
    ...(initial.source ? { source: initial.source } : {}),
    ...(initial.thinkingLevel !== undefined ? { thinkingLevel: initial.thinkingLevel } : {}),
    ...(initial.requestId ? { requestId: initial.requestId } : {}),
    ...(initial.draftRef ? { draftRef: initial.draftRef } : {}),
    ...(initial.revision !== undefined ? { revision: initial.revision } : {}),
    ...(initial.work ? { work: initial.work } : {}),
    releaseAuthorization: () => {
      initial.work?.settle("cancelled", { reason: "The session ended before this request ran" });
    },
  };
  let releaseActiveAuthorization: (() => void) | undefined;
  // Take the next queued follow-up. It stays pending, as `handingOver`, until
  // its turn reaches the backend (#1002).
  const dequeue = (): QueuedFollowUp | null => {
    const entry = turn.queue.shift() ?? null;
    turn.handingOver = entry ?? undefined;
    if (entry) {
      // A queued follow-up is its own turn — give it a fresh identity, and
      // its own terminal disposition.
      turn.turnId = entry.lifecycleTurnId ?? crypto.randomUUID();
      turn.lastResult = null;
    }
    return entry;
  };
  // A handed-over entry that will not run leaves the pending list with why.
  const dropHandedOver = (entry: QueuedFollowUp, reason: string): void => {
    if (turn.handingOver !== entry) return;
    turn.handingOver = undefined;
    coordinator.queueChanged(turn.sessionId, { dropped: { entries: [entry], reason } });
  };

  let activeLifecycle = initialLifecycle;
  try {
    while (next && !turn.cancelled) {
      const current: QueuedFollowUp = next;
      const lifecycle = turn.turnId === initialTurnId ? initialLifecycle : current.lifecycle ?? (host.activity
        ? createTurnLifecycle(host.activity.store, turn.turnId, turn.sessionId, current.queuedAt ?? Date.now(), () => host.activity!.stream.pump()) : undefined);
      activeLifecycle = lifecycle;
      if (current.queuedAt !== undefined) lifecycle?.mark("dequeuedAt");
      releaseActiveAuthorization = current.releaseAuthorization;
      // The slot now holds this request; recovery reads it as queued until
      // its turn is handed to the backend (#964).
      turn.revision = current.revision;
      turn.startedAt = undefined;
      turn.principalId = current.principalId;
      turn.authorization = current.authorization;
      if (!turn.authorization.valid) {
        lifecycle?.finish("cancelled", REVOKED_REASON);
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        host.budgets?.end(turn.turnId);
        turn.revision = undefined;
        dropHandedOver(current, REVOKED_REASON);
        next = dequeue();
        continue;
      }
      const { text, attachments, files, client, source, thinkingLevel, requestId, draftRef, work } = current;
      turn.requestId = requestId;
      turn.draftRef = draftRef;
      turn.work = work;
      next = null;

      let workerIdentity: import("@schlessera/brain-ui-sdk/internal").WorkerNoteFacts["identity"];
      // The turn's own controller exists before the host check is awaited, so
      // a cancel accepted while the probe runs (#2416) aborts this turn's
      // admission, as one accepted during billing does.
      const abortController = new AbortController();
      turn.abortController = abortController;
      // Before transcript/source/failure recording or any runtime initialization.
      // Every queued interactive or voice turn repeats the actual host check.
      try {
        const workerHost = await requireWorkerHostRecorded(host.brainPath ?? process.cwd(), "ordinary", host.activity?.runtime, { identitySentinelDirectory: host.identitySentinelDirectory });
        if (workerHost?.identity === "separate_uid" && workerHost.workerUid !== undefined) workerIdentity = { kind: "separate_uid", workerUid: workerHost.workerUid };
        // Pi turn-runner declares no voice tool posture. Keep this early
        // admission refusal aligned with that direct-consumer guard if Pi
        // gains a voice posture, before any native maintenance workers start.
        if (backend.id === "pi" && work?.posture === "voice")
          throw new BackendRequestError("The pi backend declares no voice tool posture; a voice turn cannot run on it.");
      }
      catch (error) {
        lifecycle?.finish("denied", error instanceof Error ? error.message : String(error));
        emitTurnError(host, turn, error);
        work?.settle("error", { reason: error instanceof Error ? error.message : String(error) });
        break;
      }

      const timeoutHandle = setTimeout(() => {
        host.log.emit({
          severityText: "WARN",
          body: "turn timed out",
          // Read from the live turn: session_info may have named the session
          // after this timer was armed.
          attributes: { ...turnLogAttributes(turn), "timeout.ms": host.turnTimeoutMs },
        });
        abortController.abort();
        // Reject any pending interactive request for this turn too. A bridge
        // that awaits askUser/approval without racing the abort signal would
        // otherwise leave startTurn parked forever after abort(), leaking a
        // concurrency slot until restart. Draining unblocks the unwind.
        coordinator.drainPendingForTurn(turn, "Turn timed out");
      }, host.turnTimeoutMs);
      turn.timeoutHandle = timeoutHandle;

      // One recorder per turn identity: a queued follow-up re-mints turnId
      // and gets its own run in the activity record. The recorder is handed
      // the RESOLVED profile — `profileId` here is post pin-drop fallback and
      // carries any session_info re-pin forward between queued turns — plus
      // its billing mode, so the run's root span classifies what actually ran,
      // never what was requested.
      const billing = await resolveRunBilling(host.registry, backend.id, profileId);
      const failureRecording = await host.failureReplay.begin(backend, resumeId, turn.turnId, abortController.signal);
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
        host.budgets?.end(turn.turnId);
        turn.revision = undefined;
        await failureRecording.finish();
        clearTimeout(timeoutHandle);
        // A cancellation accepted while billing was in flight is already a
        // decision someone made; losing it because the turn's own principal
        // was revoked a moment later would erase the actor, not the turn. Drain
        // the buffer before leaving.
        recordPendingCancellations(host, turn, billing, lifecycle);
        lifecycle?.finish("cancelled", REVOKED_REASON);
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        dropHandedOver(current, REVOKED_REASON);
        next = dequeue();
        continue;
      }
      const recorder: TurnRecorder | undefined = host.activity
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
      let mainModel: string | null = billing?.model ?? null;
      if (mainModel) recorder?.setMainModel(mainModel);
      turn.recorder = recorder;
      for (const principalId of turn.pendingCancellationPrincipalIds) {
        recorder?.recordCancellation(principalId);
      }
      turn.pendingCancellationPrincipalIds.length = 0;
      // The message's source is recorded in the order the backend receives
      // its text, which is the order replay counts identical texts in. A
      // resumed session is known now; a new one is named by session_info.
      const recordSource = (sid: string): void =>
        host.catalog.recordMessageSource?.(sid, text, source ?? "typed", { thinkingLevel, turnId: turn.turnId, files });
      // A follow-up the backend refused had its source recorded when it was
      // first handed over (#1063).
      turn.retryRequest = {
        type: "chat_message", text, attachments,
        ...(files?.length ? { files: files.map(file => ({ kind: "file" as const, path: file.path })) } : {}),
        ...(profileId ? { providerId: profileId } : {}),
        ...(client ? { client } : {}), ...(source ? { source } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(requestId ? { requestId } : {}),
      };
      turn.isManualRetry = initial.isRetry === true && turn.turnId === firstTurnId;
      const startedAt = Date.now();
      // Host admission has started: recovery reads this request as running.
      turn.startedAt = startedAt;
      if (turn.revision !== undefined && resumeId) {
        host.catalog.dispatchWork?.(resumeId, turn.revision, turn.turnId, backend.id, startedAt);
      }
      // The follow-up is the agent's now: it leaves the pending list ahead of
      // every frame of its own turn, so a client can place it in the
      // transcript where it entered the conversation (#1002). A cancel that
      // landed while billing resolved has already reported it dropped.
      if (turn.handingOver === current) {
        turn.handingOver = undefined;
        coordinator.queueChanged(turn.sessionId, { started: { entry: current, turnId: turn.turnId } });
      }
      host.reportTurnStarted(turn);
      work?.started(turn.turnId);
      let lifecycleOutcome: import("@schlessera/brain-ui-sdk/protocol").ActivitySpanOutcome = "error";
      let workOutcome: HostWorkOutcome = "error";
      let workReason: string | undefined;
      let governedHold: import("../brain/governed-turn.js").GovernedTurnHold | undefined;
      let turnEgress: Awaited<ReturnType<typeof prepareTurnEgress>> | undefined;
      let providerRelay: ProviderRelay | undefined;
      let worktreeGeneration: import("../brain/reference-worktrees.js").ReferenceWorktreeGeneration | undefined;
      let referenceViews: { public: string; private: string } | null = null, referenceTurn = false;
      let journalFailure: Error | undefined;
      let budgetFailure: Error | undefined;
      const budgetWrites = new Set<Promise<unknown>>();
      let scopeStopReason: string | undefined;
      turn.backendStarted = false;
      let enteredBackend = false;
      // Index updates this turn's applications queued (#2835): flushed once its
      // workers stop, before its Activity terminal, on every outcome.
      let settleIndex: (() => Promise<void>) | undefined;
      let cancelledAdmission = false;
      let revokedAdmission = false;
      try {
        if (initial.profileDraftId && (!initial.draftId || !initial.requestId || initial.sessionId
          || (initial.draftRef && initial.draftRef.draftId !== initial.profileDraftId)))
          throw new Error("A draft profile requires the matching first-send identity and correlation.");
        const origin = work?.posture === "voice" ? "voice" : "interactive";
        const preference = origin === "interactive"
          ? host.sessionProfiles?.preference(turn.principalId, resumeId, resumeId ? undefined : initial.profileDraftId) : undefined;
        if (host.governedTurns) lifecycle?.mark("governedStartedAt");
        else lifecycle?.skip("governed");
        // Only a backend whose turn runs on the host inference relay can name
        // the origin that relay forwards to; admission proves the recipient
        // from it, and the relay below refuses any other (#2695).
        const relayed = backend.id === "claude" || backend.id === "pi";
        const inferenceOrigin = host.governedTurns && relayed && backend.inferenceOrigin
          ? await backend.inferenceOrigin({ ...(profileId ? { profileId } : {}), ...(resumeId ? { sessionId: resumeId } : {}) }).catch(() => undefined) : undefined;
        abortController.signal.throwIfAborted();
        const handoffSource = !resumeId && turn.turnId === firstTurnId ? initial.handoffHooks?.sourceSessionId : undefined;
        governedHold = await host.governedTurns?.begin(turn.turnId, abortController.signal, origin, preference, {
          ...(inferenceOrigin ? { inferenceOrigin } : {}), ...(resumeId ? { sessionId: resumeId } : {}), ...(handoffSource ? { inherit: [handoffSource] } : {}) });
        if (governedHold) lifecycle?.mark("governedAcquiredAt");
        if (!governedHold || !host.budgets) lifecycle?.skip("budget");
        if (!governedHold || !host.journal) lifecycle?.skip("journal");
        if (governedHold && host.budgets) {
          lifecycle?.mark("budgetStartedAt");
          try { await host.budgets.begin(turn.turnId,resumeId,governedHold.policy.policy,billing?.pricingRoute); }
          catch (error) { if(error instanceof BudgetExceeded) throw error; throw new BudgetUnavailable(); }
        }
        if (governedHold && host.budgets) lifecycle?.mark("budgetAdmittedAt");
        try { if(governedHold && host.budgets) for(const item of await host.budgets.warnings(turn.turnId)) host.activity?.governance?.({
          kind:"budget_warning",turnId:turn.turnId,sessionId:turn.sessionId,actor:origin,model:mainModel,profile:governedHold.sandbox.profile ?? "strict",
          payload:{scope:item.scope,unit:item.costUsd !== null && item.costUsd >= item.warnUsd ? "usd":"tokens",
            limit:item.costUsd !== null && item.costUsd >= item.warnUsd ? item.warnUsd:item.warnTokens!,
            observed:item.costUsd !== null && item.costUsd >= item.warnUsd ? item.costUsd:item.tokens!,source:governedHold.policy.hash ? "policy":"default"}}); } catch {throw new BudgetUnavailable();}
        if (governedHold) recorder?.setWorkerProfile(governedHold.sandbox.profile ?? "strict");
        if (governedHold && host.journal) {
          lifecycle?.mark("journalStartedAt");
          await host.journal.begin(turn.turnId, { sessionId: turn.sessionId ?? null,
            actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel,
            profile: governedHold.sandbox.profile === "governed" ? "governed" : "strict", policyHash: governedHold.policy.hash },
          error => {
            // A real timeout/cancel already won; never relabel that terminal.
            if (abortController.signal.aborted || turn.cancelled) return;
            journalFailure = error;
            abortController.abort(error);
            coordinator.drainPendingForTurn(turn, error.message);
          }, abortController.signal);
          lifecycle?.mark("journalBeganAt");
        }
        abortController.signal.throwIfAborted();
        // Managed worktrees (#2430): a journaled turn's workers bind one empty generation.
        // A worktree reaches it only through an access that first covers it in this journal.
        if (governedHold && host.journal && host.referenceWorktreeAccess && host.referenceWorktrees && host.journal.summary(turn.turnId).state === "recording") {
          try {
            worktreeGeneration = await host.referenceWorktrees.openGeneration({ principalId: turn.principalId, turnId: turn.turnId,
              profile: governedHold.sandbox.profile === "governed" ? "governed" : "strict", signal: abortController.signal });
            host.referenceWorktreeGenerations.set(turn.turnId, worktreeGeneration);
          } catch (error) {
            // The turn runs without worktree access; nothing was granted.
            if (abortController.signal.aborted) throw error;
            host.log.emit({ severityText: "WARN", body: `managed worktree generation unavailable for this turn: ${String(error)}` });
          }
        }
        // Reference tools (#2432): the turn's workers bind the principal's source
        // views and the generation above; the tools report only what they bind.
        if (governedHold && host.referenceTools) {
          referenceTurn = true;
          referenceViews = await host.referenceTools.begin(turn.turnId, { principalId: turn.principalId, posture: work?.posture === "voice" ? "voice" : "interactive",
            generation: worktreeGeneration ?? null, signal: abortController.signal });
        }
        const scopeTurnId = turn.turnId;
        if (governedHold && host.scope) await host.scope.begin(scopeTurnId, { sessionId: turn.sessionId ?? null, principalId: turn.principalId,
          origin, model: () => mainModel, profile: governedHold.sandbox.profile === "governed" ? "governed" : "strict", policy: governedHold.policy.policy,
          source: governedHold.policy.source === "default" ? "default" : "policy", hardTimeoutMs: host.turnTimeoutMs,
          current: () => turn.turnId === scopeTurnId && !abortController.signal.aborted && current.authorization.valid && current.authorization.expiresAt > Date.now() && host.isPrincipalAuthorized(current.principalId),
          stop: reason => {
            if (turn.turnId !== scopeTurnId || abortController.signal.aborted) return;
            scopeStopReason = reason; turn.cancelled = true;
            const frame = withTurnScope({ type: "text_delta", text: reason }, turn, turn.turnId);
            host.sendToClients(frame); work?.observe(frame);
            abortController.abort(new Error(reason)); coordinator.drainPendingForTurn(turn, reason);
          } });
        abortController.signal.throwIfAborted();
        // Native admission awaits can outlive principal revocation or expiry.
        // Refuse this request without cancelling another principal's queue.
        host.expireAuthorizationContexts();
        if (!turn.authorization.valid) { revokedAdmission = true; throw new Error(REVOKED_REASON); }
        if (resumeId && !current.refusedFollowUp) recordSource(resumeId);
        // Locally answered commands the agent has not seen yet ride on this
        // prompt (#582), taken here, past the last await, so an exchange is
        // only marked carried by a prompt that is actually handed over. The
        // source above is recorded for the user's text alone, which is what
        // replay matches once the context is stripped again.
        const drafted = draftExchanges;
        draftExchanges = [];
        const prompt = (initial.replayPrompt !== undefined && turn.turnId === firstTurnId) ? initial.replayPrompt : withLocalContext(withTrackFiles(text, files), [
          ...drafted,
          ...(current.refusedFollowUp?.exchanges ?? []),
          ...(resumeId ? (host.catalog.takePendingLocalExchanges?.(resumeId) ?? []) : []),
        ]);
        turn.retryPrompt = prompt;
        // One budget observation's warnings and block: the agent's own
        // inference or a relayed CLI provider request (#1673).
        const budgetAttribution = () => ({turnId:turn.turnId,sessionId:turn.sessionId,actor:origin,model:mainModel,
          profile:governedHold!.sandbox.profile ?? "strict"} as const);
        const budgetWarnings = (warnings: readonly BudgetObservation[]) => {
          for (const item of warnings) host.activity?.governance?.({kind:"budget_warning",...budgetAttribution(),
            payload:{scope:item.scope,unit:item.costUsd !== null && item.costUsd >= item.warnUsd ? "usd":"tokens",
              limit:item.costUsd !== null && item.costUsd >= item.warnUsd ? item.warnUsd:item.warnTokens!,
              observed:item.costUsd !== null && item.costUsd >= item.warnUsd ? item.costUsd:item.tokens!,
              source:governedHold!.policy.hash ? "policy":"default"}});
        };
        const budgetBlocked = (item: BudgetObservation, backstop: boolean) => {
          host.activity?.governance?.({kind:"budget_block",...budgetAttribution(),payload:{scope:item.scope,
            unit:backstop || item.costUsd !== null && item.costUsd >= item.blockUsd ? "usd":"tokens",
            limit:backstop || item.costUsd !== null && item.costUsd >= item.blockUsd ? item.blockUsd:item.blockTokens,
            observed:backstop ? item.costUsd ?? 0 : item.costUsd !== null && item.costUsd >= item.blockUsd ? item.costUsd:item.tokens!,
            source:governedHold!.policy.hash ? "policy":"default",stage:backstop ? "sdk_backstop":"mid_turn"}});
          budgetFailure=new BudgetExceeded(item,backstop ? "sdk_backstop":"mid_turn");
          recorder?.recordBudgetStop(budgetFailure.message);
          abortController.abort(budgetFailure);coordinator.drainPendingForTurn(turn,budgetFailure.message);
        };
        const budgetUnavailable = () => {
          budgetFailure = new BudgetUnavailable();
          recorder?.recordBudgetStop(budgetFailure.message,"budget_unavailable");
          abortController.abort(budgetFailure);coordinator.drainPendingForTurn(turn,"Inference budget accounting became unavailable.");
        };
        // A budget write's commit, and what the turn does with its outcome;
        // the turn's outcome waits for every one (#2850).
        const budgetWrite = (work: Promise<unknown>) => {
          const pending = work.catch(() => { if (!budgetFailure) budgetUnavailable(); }).finally(() => budgetWrites.delete(pending));
          budgetWrites.add(pending);
        };
        const bridge = makeBridge(
          host,
          turn,
          text,
          backend.id,
          recorder,
          resumeId
            ? undefined
            : (sid) => {
                // A new conversation is accepted the moment it has a name,
                // and its turn is already running (#964).
                const revision = acceptRequest(host, sid, turn.requestId, backend.id);
                turn.revision = revision;
                if (revision !== undefined && turn.startedAt !== undefined) {
                  host.catalog.dispatchWork?.(sid, revision, turn.turnId, backend.id, turn.startedAt);
                }
                host.governedTurns?.bindSession(turn.turnId, sid);
                recordSource(sid);
                recordDraftExchanges(host, sid, drafted);
                initial.handoffHooks?.onNamed(sid);
              },
          failureRecording.observe,
          // A follow-up's pill label is its turn's request label (#1004).
          () => current.label,
          backend.brainApplicationPolicy?.({ profileId,
            ...(work?.posture === "voice" ? { posture: "voice", noGrantSurface: true, enforceAllowedTools: true } : {}) }),
          governedHold ? protectedPaths(governedHold.policy.policy) : undefined,
          governedHold ? { origin, actualProfile: governedHold.sandbox.profile === "governed" ? "governed" : "strict",
            ...(initial.profileDraftId && !resumeId && preference ? { draftId: initial.profileDraftId, preference } : {}) } : undefined,
          host.budgets && governedHold ? (usage,backstop=false) => {
            if (budgetFailure || abortController.signal.aborted || turn.cancelled) return;
            // The report is priced now; its receipt, warnings and any block
            // follow its commit (#2850), judged against the turn as it is then.
            const live = () => !budgetFailure && !abortController.signal.aborted && !turn.cancelled;
            try {
              if (backstop) {
                budgetWrite(host.budgets!.backstop(turn.turnId).then(saved => { if (live()) budgetBlocked({...saved.scopes[0]!,blocked:true}, true); }));
                return;
              }
              const observed = host.budgets!.observe(turn.turnId,usage);
              if (!observed) return;
              const listPrice = host.budgets!.listPrice(turn.turnId,usage);
              budgetWrite(observed.then(result => {
                if (!live()) return;
                budgetWarnings(result.warnings);
                const {costUsd:reportedCost,...counts}=usage;
                void reportedCost;
                host.sendToClients(withTurnScope({type:"usage",turnId:turn.turnId,usage:{...counts,
                  ...(result.receipt.listPriceCostUsd !== null ? {costUsd:result.receipt.listPriceCostUsd} : {})},
                  observedAt:result.receipt.observedAt,budget:result.receipt},turn));
                if (result.blocked) budgetBlocked(result.blocked, false);
              }));
              return {...usage,...(listPrice !== null ? {costUsd:listPrice} : {})};
            } catch { budgetUnavailable(); }
          } : undefined,
          billing,
          { current: () => mainModel, bind: model => {
            if (host.journal && governedHold && !host.journal.bindModel(scopeTurnId, turn.sessionId, model)) return;
            mainModel = model; recorder?.setMainModel(model);
          } },
          governedHold?.sandbox.providerMasks ? { folders: governedHold.sandbox.providerMasks.folders, policy: governedHold.policy,
            ...(governedHold.typeFolders ? { typeFolders: governedHold.typeFolders } : {}),
            ...(governedHold.sandbox.inferenceRecipient ? { recipient: governedHold.sandbox.inferenceRecipient.name } : {}) } : undefined,
          governedHold?.dataTree ? { tree: governedHold.dataTree, ...(governedHold.startupView ? { view: governedHold.startupView.root } : {}) } : undefined
        );
        // A failed update is already on each application's Activity record,
        // and its paths stay queued for the next reader; the turn still ends.
        settleIndex = () => settleTurnIndex(bridge).catch(() => {});
        const fallback = governedHold?.sandbox.fallbackReason;
        if (fallback) {
          const match = /Error: (.+?) is (?:a )?(symlink|hardlinked)/.exec(fallback);
          if (match || fallback.includes("another mount")) host.activity?.governance?.({
            kind: "strict_fallback", payload: { path: match?.[1] ?? ".", reason: match?.[2] === "symlink" ? "symlink" : match ? "hardlink" : "mount_point" },
            turnId: turn.turnId, sessionId: turn.sessionId, actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel, profile: "strict",
          });
        }
        // A governed or strict Claude or pi turn on managed native storage gets
        // its own proxy and the host inference relay (#1665). Without that
        // storage the turn keeps its current network; worker-host status says which.
        if (governedHold?.sandbox.inferenceRecipient && !(governedHold.managedStorage && relayed))
          throw new Error("This turn's provider folders were admitted for a recipient its inference relay cannot enforce; retry the turn.");
        if (governedHold?.managedStorage && relayed) {
          const governance = host.activity?.governance, governanceWrites = host.activity?.governanceWrites;
          turnEgress = await prepareTurnEgress({ policy: governedHold.policy.policy, bridge, controller: abortController,
            turnId: turn.turnId, sessionId: () => turn.sessionId ?? null, model: () => mainModel,
            profile: governedHold.sandbox.profile === "governed" ? "governed" : "strict", origin,
            // A record's commit failure stops the turn, as a synchronous one did (#2850).
            ...(governanceWrites ? { record: (event: Parameters<typeof governanceWrites.record>[0]) => governanceWrites.record(event), governanceWrites }
              : governance ? { record: (event: Parameters<typeof governance>[0]) => governance(event) } : {}),
            ...(host.activity?.governanceDb ? { governanceDb: host.activity.governanceDb } : {}),
          });
          // The CLI's paid providers reach the network only through this relay,
          // which holds their keys, shares the turn's egress admission and
          // meters each request on the turn (#1673).
          // The turn this relay meters, fixed now: a late report never lands on a later turn.
          const egress = turnEgress, hold = governedHold, relayTurnId = turn.turnId;
          providerRelay = startProviderRelay({ egress, ...(host.cliProviderOrigins ? { origins: host.cliProviderOrigins } : {}),
            admit: async () => {
              if (budgetFailure) return { allowed: false, message: budgetFailure.message };
              if (!host.budgets) return { allowed: true };
              try {
                const blocked = await host.budgets.providerAdmission(relayTurnId, hold.policy.policy);
                // The turn may have stopped while admission waited for earlier budget writes.
                const stopped = budgetFailure as Error | undefined;
                if (stopped) return { allowed: false, message: stopped.message };
                return blocked ? { allowed: false, message: new BudgetExceeded(blocked, "mid_turn").message } : { allowed: true };
              } catch { return { allowed: false, message: new BudgetUnavailable().message }; }
            },
            observe: attempt => {
              if (!host.budgets) return;
              try {
                budgetWrite(host.budgets.observeProvider(relayTurnId, attempt).then(result => {
                  if (!result || budgetFailure || abortController.signal.aborted || turn.cancelled) return;
                  // A crossed block refuses each further relayed request (ruling D3 on
                  // #1673); the agent's next completed response, which sees the same
                  // scopes, stops the turn as any usage over a block does.
                  budgetWarnings(result.warnings);
                }));
              } catch { if (!budgetFailure) budgetUnavailable(); }
            },
          });
          linkSync(providerRelay.socketPath, join(egress.dir, PROVIDER_RELAY_SOCKET_NAME));
          const customKeys = heldCustomProviderKeys(host.cliProviderOrigins);
          if (customKeys.length) writeFileSync(join(egress.dir, PROVIDER_RELAY_KEYS_NAME), `${customKeys.join("\n")}\n`, { mode: 0o640 });
        }
        // The session's recorded untrusted input, read live by outward admission and the note (G6).
        const governanceDb = host.activity?.governanceDb;
        const commandPolicy = governedHold?.sandbox.commandPolicy && governanceDb ? { ...governedHold.sandbox.commandPolicy,
          // A taint submitted to the write worker counts before it commits (#2850).
          taint: () => host.activity?.governanceWrites ? host.activity.governanceWrites.taint(turn.turnId, turn.sessionId ?? null)
            : sessionTaint(governanceDb, turn.turnId, turn.sessionId ?? null) } : governedHold?.sandbox.commandPolicy;
        enteredBackend = true;
        turn.backendStarted = true;
        lifecycle?.mark("backendInvokedAt");
        await backend.startTurn({
          applicationAuthority: "server",
          ...(host.journal && governedHold ? { persistClaudeMemory: (change, save) => host.journal!.persistClaudeMemory(turn.turnId, change, save) } : {}),
          ...(governedHold?.startupView ? { workerStartupView: governedHold.startupView } : {}),
          ...(host.scope && governedHold ? { workerStarted: worker => host.scope!.workerStarted(scopeTurnId, worker) } : {}),
          ...(host.journal && governedHold ? { toolExecution: (toolUseId, path) => host.journal!.toolExecuted(scopeTurnId, toolUseId, path) } : {}),
          ...(governedHold ? { workerSandbox: { ...governedHold.sandbox, ...(commandPolicy ? { commandPolicy } : {}), ...(turnEgress ? { egress: turnEgress } : {}),
            ...(worktreeGeneration ? { worktrees: { source: worktreeGeneration.path } } : {}), ...(referenceViews ? { references: referenceViews } : {}), noteFacts: {
            ...governedHold.sandbox.noteFacts,
            ...(workerIdentity ? { identity: workerIdentity } : {}),
            history: { journal: Boolean(host.journal && host.journal.summary(turn.turnId).state === "recording"),
              userRevert: Boolean(host.turnReverts && host.journal && host.journal.summary(turn.turnId).state === "recording" && work?.posture !== "voice") },
          } }, workerLock: host.workerLock } : {}),
          prompt,
          ...(host.budgets && governedHold ? {maxBudgetUsd:host.budgets.remaining(turn.turnId),
            sessionBudgetLimits: inferenceBudgetLimits(host.budgets.receipt(turn.turnId)),
            budgetContext: inferenceBudgetContext(host.budgets.receipt(turn.turnId)),
          } : {}),
          attachments,
          sessionId: resumeId,
          profileId,
          signal: abortController.signal,
          // The budget this very timer enforces, so the backend can put the
          // real number in front of the model instead of it finding the cap
          // mid-flight.
          turnBudgetMs: host.turnTimeoutMs,
          bridge: turnEgress?.bridge ?? bridge,
          turnId: turn.turnId,
          ...(client ? { client } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          // A new turn started by voice runs the voice posture: the backend's
          // named voice allowlist, enforced, with no surface that could grant
          // a card (docs/decisions/voice-permission.md). A backend without a
          // voice posture refuses the turn. A follow-up joining an ordinary
          // turn never gets here, so that turn keeps its posture.
          ...(work?.posture === "voice" ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
        });
        turn.backendStarted = false;
        await settleIndex?.();
        // Every relayed attempt reports before the turn's accounting closes.
        await providerRelay?.stop();
        turnEgress?.stop();
        // Every egress record commits, or fails the turn, before its outcome (#2850).
        await turnEgress?.settled();
        const egressFailure = turnEgress?.recordingFailure();
        if (egressFailure) throw egressFailure;
        // Final observation is part of this host outcome, after worker writes
        // stop and before its Activity terminal, quarantine or gate release.
        // A worktree generation retires first: no grant can follow that observation.
        if (worktreeGeneration) await host.referenceWorktrees!.retireGeneration(worktreeGeneration.id);
        await host.journal?.finish(turn.turnId);
        while (budgetWrites.size) await Promise.all([...budgetWrites]);
        if (budgetFailure) throw budgetFailure;
        if (journalFailure) throw journalFailure;
        // A host timeout ends the turn like a cancel: its late result is
        // never narrated, and the receipt keeps the reason.
        workOutcome = turn.cancelled || abortController.signal.aborted || turn.lastResult === "cancelled"
          ? "cancelled"
          : turn.lastResult === "error"
            ? "error"
            : "completed";
        if (scopeStopReason) workReason = scopeStopReason;
        else if (abortController.signal.aborted && !turn.cancelled) workReason = "Turn timed out";
        // A resolved startTurn is not a successful turn: backends resolve for
        // runtime failures and report them on the terminal result frame, which
        // the bridge recorded on the turn.
        if (turn.lastResult === "error") {
          host.reportTurnFailed("BACKEND_RESULT_ERROR", turn);
        } else {
          host.reportTurnCompleted(turn, Date.now() - startedAt);
        }
        // Terminal precedence: cancellation and timeout are host-owned facts;
        // otherwise the recorder refines from the buffered result frame.
        lifecycleOutcome = turn.cancelled ? "cancelled" : abortController.signal.aborted ? "timeout" : turn.lastResult === "error" ? "error" : "success";
        recorder?.finish(
          turn.cancelled
            ? "cancelled"
            : abortController.signal.aborted
              ? "timeout"
              : turn.lastResult === "error"
                ? "error"
                : "success"
        );
      } catch (err) {
        lifecycle?.mark("failureObservedAt");
        await settleIndex?.();
        await turnEgress?.settled();
        while (budgetWrites.size) await Promise.all([...budgetWrites]);
        const egressFailure = turnEgress?.recordingFailure();
        const terminal = budgetFailure ?? journalFailure ?? egressFailure ?? err;
        if (terminal instanceof BudgetExceeded && terminal.stage === "admission") {
          recorder?.recordBudgetStop(terminal.message);
          const item=terminal.observation;
          host.activity?.governance?.({kind:"budget_block",turnId:turn.turnId,sessionId:turn.sessionId,
            actor:work?.posture === "voice" ? "voice":"interactive",model:mainModel,profile:governedHold?.sandbox.profile ?? "strict",
            payload:{scope:item.scope,unit:item.costUsd !== null && item.costUsd >= item.blockUsd ? "usd":"tokens",
              limit:item.costUsd !== null && item.costUsd >= item.blockUsd ? item.blockUsd:item.blockTokens,
              observed:item.costUsd !== null && item.costUsd >= item.blockUsd ? item.costUsd:item.tokens!,
              source:governedHold?.policy.hash ? "policy":"default",stage:"admission"}});
        }
        if (terminal instanceof BudgetUnavailable) recorder?.recordBudgetStop(terminal.message,"budget_unavailable");
        cancelledAdmission = !enteredBackend && (turn.cancelled || revokedAdmission) && !budgetFailure && !journalFailure && !egressFailure && !scopeStopReason;
        turn.backendStarted = false;
        if (!cancelledAdmission && (!scopeStopReason || budgetFailure || journalFailure || egressFailure)) emitTurnError(host, turn, terminal);
        lifecycleOutcome = terminal instanceof BudgetExceeded && terminal.stage === "admission" ? "denied" : budgetFailure ? "error" : turn.cancelled || revokedAdmission ? "cancelled" : journalFailure || egressFailure ? "error" : abortController.signal.aborted ? "timeout" : "error";
        recorder?.finish(
          budgetFailure ? "error" : turn.cancelled || revokedAdmission ? "cancelled" : journalFailure || egressFailure ? "error" : abortController.signal.aborted ? "timeout" : "error"
        );
        // A host timeout is host-terminal like a cancel: its late result is
        // never narrated (the work keeps the reason).
        workOutcome = budgetFailure ? "error" : turn.cancelled || revokedAdmission || !journalFailure && !egressFailure && abortController.signal.aborted ? "cancelled" : "error";
        workReason = !turn.cancelled && !budgetFailure && !journalFailure && !egressFailure && abortController.signal.aborted
          ? "Turn timed out"
          : terminal instanceof Error ? terminal.message : String(terminal);
      } finally {
        await providerRelay?.stop();
        turnEgress?.stop();
        // The session's next turn reads these hosts back as contacted (G6).
        await turnEgress?.settled();
        if (referenceTurn) host.referenceTools?.end(turn.turnId);
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
              turnId: turn.turnId, sessionId: turn.sessionId, actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel,
              profile: governedHold?.sandbox.profile ?? "strict" });
          }
        }
        catch (error) { host.log.emit({ severityText: "ERROR", body: `governed reconciliation failed: ${String(error)}` }); }
        if (governedHold?.sandbox.profile === "governed") host.governedTurns?.refresh(host.workerLock);
        // The recorder has written the terminal: from here on the Activity
        // record, not this slot, answers for the request (#964).
        host.inboxTools?.shares?.end(turn.turnId);
        turn.shareId = undefined;
        host.budgets?.end(turn.turnId);
        turn.revision = undefined;
        turn.startedAt = undefined;
        turn.backendStarted = false;
        await failureRecording.finish(turn.sessionId);
        // No backend existed to publish its usual cancelled status. Send it
        // only after native preparation and host cleanup have settled.
        if (cancelledAdmission) host.sendToClients(withTurnScope({ type: "status", status: "cancelled",
          detail: "Cancelled before starting", ...(turn.requestId ? { requestId: turn.requestId } : {}) }, turn));
        // A backend result can precede asynchronous journal finalization.
        // Recovery now reads the committed terminal, before a successor starts.
        else if (turn.sessionId) host.sendToClients(withTurnScope({ type: "status", status: "idle" }, turn));
        lifecycle?.finish(lifecycleOutcome, workReason ?? null);
        clearTimeout(timeoutHandle);
        turn.recorder = undefined;
        work?.settle(workOutcome, { sessionId: turn.sessionId, ...(workReason ? { reason: workReason } : {}) });
        turn.work = undefined;
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        // The recorder's writes, terminal included, commit off the event loop
        // (#2814); the slot waits for them before the next turn or its end.
        await recorder?.settled();
      }

      // Subsequent (queued) turns resume the now-known session and keep its
      // pin. turn.providerId is the resolved profile (set from initial routing
      // and re-pinned by session_info); carrying it forward stops a queued
      // follow-up from silently dropping onto the default profile/model/billing.
      resumeId = turn.sessionId ?? resumeId;
      profileId = turn.providerId ?? profileId;

      // A live follow-up still being delivered may yet be refused and rejoin
      // the queue ahead of the messages sent after it: let it settle before
      // the next of those starts (#1063). With nothing queued the slot ends
      // as before; a delivery may outlive its turn.
      if (!turn.cancelled && turn.queue.length > 0) await settleDeliveries(turn);
      if (!turn.cancelled) next = dequeue();
    }
  } catch (error) {
    activeLifecycle?.finish(turn.cancelled ? "cancelled" : turn.abortController?.signal.aborted ? "timeout" : "error",
      error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    releaseActiveAuthorization?.();
    next?.releaseAuthorization();
    // Whatever is still pending will never run in this slot. A handed-over
    // entry's lease is `next`'s or the active one, both released above.
    const unstarted = turn.handingOver;
    turn.handingOver = undefined;
    const queued = turn.queue.splice(0);
    for (const entry of queued) entry.releaseAuthorization();
    coordinator.queueChanged(turn.sessionId, {
      dropped: { entries: unstarted ? [unstarted, ...queued] : queued, reason: SLOT_ENDED_REASON },
    });
    if (turn.sessionId && coordinator.bySession.get(turn.sessionId) === turn) {
      coordinator.bySession.delete(turn.sessionId);
    }
    coordinator.running.delete(turn);
    coordinator.drainPendingForTurn(turn, "Session ended");
  }
}

/**
 * Profile identity + billing mode for a turn's root span. When the slot has no
 * resolved profile id (a resumed session whose pin was dropped), the backend
 * runs its default profile — the backend's first roster entry — so THAT
 * profile's identity and billing are recorded, not the dead pin's. Hidden
 * profiles are included: a session pinned to a profile the user later hid
 * still runs on it and must classify as it. Never throws: an unreadable
 * roster records no billing attrs, and the rollup leaves billing unknown
 * rather than inferring it from server credentials.
 */
export async function resolveRunBilling(
  registry: BackendRegistry,
  backendId: string,
  profileId: string | undefined
): Promise<
  { profileId: string; model?: string; billingMode?: BillingMode; pricingRoute?: PricingRoute } | undefined
> {
  try {
    const providers = await registry.listAllProviders({ includeHidden: true });
    const resolved = profileId
      ? providers.find((provider) => provider.id === profileId)
      : providers.find((provider) => provider.backendId === backendId);
    if (!resolved) return undefined;
    return {
      profileId: resolved.id,
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.billingMode ? { billingMode: resolved.billingMode } : {}),
      ...(resolved.pricingRoute ? { pricingRoute: resolved.pricingRoute } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Queue sizes are only ever reported to a human, so one decimal of MB is plenty. */
function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * How long a slot waits for its live follow-ups' deliveries before it starts
 * the next queued turn anyway. A backend settles a delivery as it takes the
 * message, so this only bounds one that never settles.
 */
export const FOLLOW_UP_SETTLE_MS = 5_000;

async function settleDeliveries(turn: RunningTurn): Promise<void> {
  if (!turn.deliveries?.size) return;
  // A cancel aborts the slot's controller; it must not wait out the bound.
  const { signal } = turn.abortController;
  if (signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FOLLOW_UP_SETTLE_MS);
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.allSettled([...turn.deliveries]), bound]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Apply the same queue budgets during routing and during a running turn. */
function queueFollowUp(host: WsHost, ws: WSContext, sessionId: string, slot: { queue: QueuedFollowUp[] }, entry: QueuedFollowUp): void {
  const parked = queuedBytes(slot);
  const incoming = queuedFollowUpBytes(entry);
  // A single message can never exceed the budget on its own: the frame cap
  // is 12 MB and a message's attachments are capped well below that, so an
  // empty queue always has room and this cannot wedge.
  const overBudget = parked + incoming > QUEUE_MAX_BYTES;
  const overDepth = slot.queue.length >= MAX_SESSION_QUEUE;

  if (overBudget || overDepth) {
    host.sendMessage(
      ws,
      // Session-scoped only: the rejected message would have become a
      // FUTURE turn in this slot, not the one currently running.
      withSessionId(
        {
          type: "error",
          code: "SESSION_QUEUE_FULL",
          ...(entry.requestId ? { requestId: entry.requestId } : {}),
          message: overBudget
            ? `This session's queue is full (${formatMb(parked)} of ${formatMb(QUEUE_MAX_BYTES)}; this message needs ${formatMb(incoming)}). Wait for it to catch up.`
            : `This session's queue is full (${MAX_SESSION_QUEUE} messages). Wait for it to catch up.`,
        },
        sessionId
      )
    );
    // The entry never joins a queue, so nothing else will ever release its
    // lease: a refused follow-up would otherwise hold its principal
    // discoverable forever and the registry would never empty.
    entry.work?.settle("refused", { reason: "This session's queue is full." });
    entry.releaseAuthorization();
    return;
  }

  // Queue it as the session's next turn; report queued immediately.
  try { host.catalog.clearRetryRequest?.(sessionId); }
  catch (err) { entry.releaseAuthorization(); throw err; }
  // In the order the host received them: only a refused live follow-up
  // rejoins behind messages sent after it, and it goes back ahead of them.
  const later = entry.sendOrder === undefined
    ? -1
    : slot.queue.findIndex((queued) => queued.sendOrder !== undefined && queued.sendOrder > entry.sendOrder!);
  // Accepted: it takes the session's next revision before it joins the
  // queue. One that rejoins ahead of later messages takes none: the latest
  // acceptance is theirs, and recovery must keep answering for it (#964).
  if (later === -1) {
    const revision = acceptRequest(host, sessionId, entry.requestId, host.catalog.getStoredBackendId(sessionId));
    if (revision !== undefined) entry.revision = revision;
  }
  entry.followUpId = crypto.randomUUID();
  entry.queuedAt = Date.now();
  if (host.activity && !entry.lifecycle) {
    entry.lifecycleTurnId = crypto.randomUUID();
    entry.lifecycle = createTurnLifecycle(host.activity.store, entry.lifecycleTurnId, sessionId, entry.queuedAt, () => host.activity!.stream.pump());
    const release = entry.releaseAuthorization;
    entry.releaseAuthorization = () => { entry.lifecycle?.finish("cancelled", "Removed from the queue before completion"); release(); };
  }
  if (later === -1) slot.queue.push(entry);
  else slot.queue.splice(later, 0, entry);
  const total = parked + incoming;
  // Accepted, but heavy enough that the sender should know before they hit
  // the wall — every queued byte is held in this process until its turn runs.
  const detail =
    total >= QUEUE_WARN_BYTES
      ? `Queue is holding ${formatMb(total)} across ${slot.queue.length} messages (limit ${formatMb(QUEUE_MAX_BYTES)}).`
      : undefined;
  if (detail) {
    host.log.emit({
      severityText: "WARN",
      body: "session follow-up queue is heavy",
      attributes: {
        "session.id": sessionId,
        size: formatMb(total),
        queued: slot.queue.length,
      },
    });
  }
  host.sendToClients(
    withSessionId({ type: "status", status: "queued", ...(entry.requestId ? { requestId: entry.requestId } : {}), ...(detail ? { detail } : {}) }, sessionId)
  );
  host.coordinator.queueChanged(sessionId);
  host.labels?.followUpQueued(sessionId, entry);
  // Queued is accepted: the sent revision of its draft is consumed now.
  acceptDraft(host, { draftRef: entry.draftRef, sessionId, resumed: true, requestId: entry.requestId, principalId: entry.principalId });
}

/** Dispatch a chat_message: follow-up to a running session, or a new session. */
export async function handleChatMessage(
  host: WsHost,
  ws: WSContext,
  msg: {
    authorization: AuthorizationContext;
    shareId?: string;
    text: string;
    sessionId?: string;
    attachments: ChatImageAttachment[];
  files?: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[];
    providerId?: string;
    client?: ClientEnvironment;
    source?: MessageSource;
    thinkingLevel?: ThinkingLevel;
    requestId?: string;
    draftId?: string;
    profileDraftId?: string;
    /** Only present when the host stores drafts (#979). */
    draftRef?: DraftRef;
    localExchanges?: LocalExchange[];
    replayPrompt?: string;
    isRetry?: boolean;
    handoffHooks?: HandoffHooks;
    /** Host-orchestrated work (#957); always queues as its own turn. */
    work?: HostWork;
  }
): Promise<void> {
  const {
    authorization,
    text,
    attachments,
    files,
    sessionId,
    providerId: requestedProviderId,
    client,
    source,
    thinkingLevel,
    requestId,
    draftId,
    draftRef,
    localExchanges,
    work,
  } = msg;
  const { coordinator } = host;
  const sendOrder = ++host.nextSendOrder;
  // Exchanges sent with a message to a session that already exists are
  // recorded like `local_exchange` frames: the prompt handed over next
  // carries them, whichever of the paths below hands it over.
  if (sessionId && localExchanges?.length) {
    for (const exchange of localExchanges) {
      const saved = host.catalog.recordLocalExchange?.(sessionId, exchange, false) ?? false;
      host.sendMessage(ws, {
        type: "local_exchange_result",
        sessionId,
        exchangeId: exchange.id,
        saved,
        ...(saved ? {} : { reason: "The server could not store it." }),
      });
    }
  }
  const runningTurn = sessionId ? coordinator.bySession.get(sessionId) : undefined;

  const starting = sessionId ? coordinator.startingBySession.get(sessionId) : undefined;
  if (msg.shareId && (starting || runningTurn)) {
    host.sendMessage(ws, { type: "error", code: "SESSION_BUSY", ...(sessionId ? { sessionId } : {}),
      ...(requestId ? { requestId } : {}), message: "A share must acquire its own session/item ownership after this turn ends." });
    return;
  }
  if (starting && sessionId) {
    if (starting.cancelled) {
      host.sendMessage(ws, { type: "error", code: "SESSION_BUSY", sessionId, ...(requestId ? { requestId } : {}), message: "This session is cancelling. Wait before sending again." });
      work?.settle("refused", { reason: "This session is cancelling." });
    } else {
      queueFollowUp(host, ws, sessionId, starting, {
        principalId: authorization.principalId,
        authorization,
        text,
        attachments,
        ...(files?.length ? { files } : {}),
        ...(client ? { client } : {}),
        ...(source ? { source } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(requestId ? { requestId } : {}),
        ...(draftRef ? { draftRef } : {}),
        ...(work ? { work } : {}),
        releaseAuthorization: leaseFor(authorization, work),
        sendOrder,
      });
    }
    return;
  }

  if (runningTurn && sessionId) {
    const backend = runningTurn.backend;
    // Built only when it is queued: the lease retains the principal.
    const followUpEntry = (): QueuedFollowUp => ({
      principalId: authorization.principalId,
      authorization,
      text,
      attachments,
      ...(files?.length ? { files } : {}),
      ...(client ? { client } : {}),
      ...(source ? { source } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(requestId ? { requestId } : {}),
      ...(draftRef ? { draftRef } : {}),
      ...(work ? { work } : {}),
      releaseAuthorization: leaseFor(authorization, work),
      sendOrder,
    });
    // Inject natively only into a turn that has not streamed its result yet,
    // and never ahead of older messages queued during routing. Host work never
    // joins a running turn, and nothing joins a running host-work turn: each
    // needs its own turn identity to correlate its result (and keep its own
    // posture), and a follow-up would merge two requests (#957).
    // Only into a turn the backend already holds, too: `backendStarted` is set as
    // the turn is handed to startTurn and cleared once that returns. Before
    // then the slot is still resolving billing, failure history or native storage,
    // a resumed or dequeued turn included, and the backend has no turn to
    // inject into, so the message queues as the next turn instead (#1063).
    if (backend.capabilities.followUp && backend.followUp && runningTurn.backendStarted === true && runningTurn.lastResult === null && runningTurn.queue.length === 0 && thinkingLevel === undefined && requestId === undefined && draftRef === undefined && work === undefined && runningTurn.work === undefined) {
      // Inject into the running turn; frames flow through its bridge. The
      // device snapshot is deliberately not forwarded: a follow-up joins a
      // turn whose system prompt was already built and cannot be revised.
      host.catalog.clearRetryRequest?.(sessionId);
      runningTurn.retryRequest = undefined;
      // Recorded at the hand-off, not when followUp() settles: a backend may
      // settle after its turn has ended and the recorder has finished. One the
      // backend refuses keeps this event, since its sender did write during
      // this turn, and then runs as its own turn below.
      runningTurn.recorder?.recordFollowUp(authorization.principalId);
      // Recorded before the hand-off: the running turn's own prompt was
      // recorded before its startTurn, so identical texts keep their order.
      host.catalog.recordMessageSource?.(sessionId, text, source ?? "typed", { turnId: runningTurn.turnId, files });
      const exchanges = host.catalog.takePendingLocalExchanges?.(sessionId) ?? [];
      const prompt = withLocalContext(withTrackFiles(text, files), exchanges);
      const deliveries = (runningTurn.deliveries ??= new Set());
      const delivery: Promise<void> = (async () => {
        const releaseFollowUp = authorization.retain();
        try {
          await backend.followUp!({ sessionId, prompt, attachments });
        } catch (err) {
          // The backend's turn can end before the host learns it has, for
          // example when its input closes while it holds a result. The
          // contract's "no running turn" refusal then means "run it next",
          // like any message sent between turns (#1063).
          const slot = err instanceof BackendRequestError
            ? (coordinator.startingBySession.get(sessionId) ?? coordinator.bySession.get(sessionId))
            : undefined;
          // Not if its turn was cancelled meanwhile: that dropped everything
          // pending in it, and a slot that has replaced it belongs to a later
          // request.
          let failure: unknown = err;
          if (slot && !slot.cancelled && !runningTurn.cancelled) {
            try {
              queueFollowUp(host, ws, sessionId, slot, { ...followUpEntry(), refusedFollowUp: { exchanges } });
              return;
            } catch (queueErr) {
              // Nothing else would report it: this runs detached.
              failure = queueErr;
            }
          }
          const message = failure instanceof Error ? failure.message : String(failure);
          host.reportTurnFailed("FOLLOWUP_FAILED", runningTurn, message);
          host.sendToClients(
            withTurnScope({ type: "error", code: "FOLLOWUP_FAILED", message }, runningTurn)
          );
        } finally {
          releaseFollowUp();
        }
      })();
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    } else {
      queueFollowUp(host, ws, sessionId, runningTurn, followUpEntry());
    }
    return;
  }

  // New session (or resume of an idle one) — gated by the concurrency cap.
  const cap = host.maxConcurrentSessions();
  if (coordinator.activeRuns() >= cap) {
    host.sendMessage(ws, {
      type: "error",
      code: "SESSION_LIMIT",
      ...(requestId ? { requestId } : {}),
      message: `Too many concurrent sessions (max ${cap}). Wait for one to finish.`,
      ...(sessionId ? { sessionId } : {}),
    });
    work?.settle("refused", { reason: `Too many concurrent sessions (max ${cap}).` });
    msg.handoffHooks?.onSettled();
    return;
  }

  let revision: number | undefined;
  if (sessionId) {
    host.catalog.clearRetryRequest?.(sessionId);
    // Accepted for a known session: it takes the next revision now, before
    // routing, so anything sent after it orders after it (#964).
    revision = acceptRequest(host, sessionId, requestId, host.catalog.getStoredBackendId(sessionId));
    host.sendToClients(withSessionId({ type: "status", status: "thinking" }, sessionId));
  }
  void runSession(host, {
    authorization,
    ...(msg.replayPrompt !== undefined ? { replayPrompt: msg.replayPrompt } : {}),
    ...(msg.isRetry ? { isRetry: true } : {}),
    text,
    ...(msg.shareId ? { shareId: msg.shareId } : {}),
    sessionId,
    attachments,
    ...(files?.length ? { files } : {}),
    providerId: requestedProviderId,
    ...(client ? { client } : {}),
    ...(source ? { source } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(requestId ? { requestId } : {}),
    ...(draftId ? { draftId } : {}),
    ...(msg.profileDraftId ? { profileDraftId: msg.profileDraftId } : {}),
    ...(draftRef ? { draftRef } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(!sessionId && localExchanges?.length ? { localExchanges } : {}),
    ...(!sessionId && msg.handoffHooks ? { handoffHooks: msg.handoffHooks } : {}),
    ...(work ? { work } : {}),
  });
}
