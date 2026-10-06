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
import type { BackendRegistry } from "../agent/backend.js";
import type { WSContext } from "./clients.js";
import { withSessionId, withTurnScope } from "./frames.js";
import { makeBridge, emitTurnError } from "./bridge.js";
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
  billing: Awaited<ReturnType<typeof resolveRunBilling>> | undefined
): void {
  if (turn.pendingCancellationPrincipalIds.length === 0) return;
  const recorder =
    turn.recorder ??
    (host.activity
      ? createTurnRecorder(
          {
            store: host.activity.store,
            ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
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
  const releaseAuthorization = initial.authorization.retain();
  try {
    await runRetainedSession(host, initial);
  } finally {
    // Every early exit (cancelled while routing, revoked) lands here; a work
    // item that ran has settled already and ignores this.
    initial.work?.settle("cancelled", { reason: "The session ended before this request ran" });
    releaseAuthorization();
    initial.handoffHooks?.onSettled();
  }
}

async function runRetainedSession(
  host: WsHost,
  initial: RunSessionInput
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

  if (starting.cancelled) return;
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
    turnId: crypto.randomUUID(),
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
      turn.turnId = crypto.randomUUID();
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

  try {
    while (next && !turn.cancelled) {
      const current: QueuedFollowUp = next;
      releaseActiveAuthorization = current.releaseAuthorization;
      // The slot now holds this request; recovery reads it as queued until
      // its turn is handed to the backend (#964).
      turn.revision = current.revision;
      turn.startedAt = undefined;
      turn.principalId = current.principalId;
      turn.authorization = current.authorization;
      if (!turn.authorization.valid) {
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
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

      const abortController = new AbortController();
      turn.abortController = abortController;
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
      const billing = host.activity
        ? await resolveRunBilling(host.registry, backend.id, profileId)
        : undefined;
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
        turn.revision = undefined;
        await failureRecording.finish();
        clearTimeout(timeoutHandle);
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        // A cancellation accepted while billing was in flight is already a
        // decision someone made; losing it because the turn's own principal
        // was revoked a moment later would erase the actor, not the turn. Drain
        // the buffer before leaving.
        recordPendingCancellations(host, turn, billing);
        dropHandedOver(current, REVOKED_REASON);
        next = dequeue();
        continue;
      }
      const recorder: TurnRecorder | undefined = host.activity
        ? createTurnRecorder(
            {
              store: host.activity.store,
              ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
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
        : undefined;
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
      turn.retryRequest = {
        type: "chat_message", text, attachments,
        ...(files?.length ? { files: files.map(file => ({ kind: "file" as const, path: file.path })) } : {}),
        ...(profileId ? { providerId: profileId } : {}),
        ...(client ? { client } : {}), ...(source ? { source } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(requestId ? { requestId } : {}),
      };
      turn.retryPrompt = prompt;
      turn.isManualRetry = initial.isRetry === true && turn.turnId === firstTurnId;
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
              recordSource(sid);
              recordDraftExchanges(host, sid, drafted);
              initial.handoffHooks?.onNamed(sid);
            },
        failureRecording.observe,
        // A follow-up's pill label is its turn's request label (#1004).
        () => current.label
      );
      const startedAt = Date.now();
      // Handed to the backend now: recovery reads this request as running.
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
      let workOutcome: HostWorkOutcome = "error";
      let workReason: string | undefined;
      try {
        await backend.startTurn({
          prompt,
          attachments,
          sessionId: resumeId,
          profileId,
          signal: abortController.signal,
          // The budget this very timer enforces, so the backend can put the
          // real number in front of the model instead of it finding the cap
          // mid-flight.
          turnBudgetMs: host.turnTimeoutMs,
          bridge,
          ...(client ? { client } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          // A new turn started by voice runs the voice posture: the backend's
          // named voice allowlist, enforced, with no surface that could grant
          // a card (docs/decisions/voice-permission.md). A backend without a
          // voice posture refuses the turn. A follow-up joining an ordinary
          // turn never gets here, so that turn keeps its posture.
          ...(work?.posture === "voice" ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
        });
        // A host timeout ends the turn like a cancel: its late result is
        // never narrated, and the receipt keeps the reason.
        workOutcome = turn.cancelled || abortController.signal.aborted || turn.lastResult === "cancelled"
          ? "cancelled"
          : turn.lastResult === "error"
            ? "error"
            : "completed";
        if (abortController.signal.aborted && !turn.cancelled) workReason = "Turn timed out";
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
        emitTurnError(host, turn, err);
        recorder?.finish(
          turn.cancelled ? "cancelled" : abortController.signal.aborted ? "timeout" : "error"
        );
        // A host timeout is host-terminal like a cancel: its late result is
        // never narrated (the work keeps the reason).
        workOutcome = turn.cancelled || abortController.signal.aborted ? "cancelled" : "error";
        workReason = !turn.cancelled && abortController.signal.aborted
          ? "Turn timed out"
          : err instanceof Error ? err.message : String(err);
      } finally {
        // The recorder has written the terminal: from here on the Activity
        // record, not this slot, answers for the request (#964).
        turn.revision = undefined;
        turn.startedAt = undefined;
        await failureRecording.finish(turn.sessionId);
        clearTimeout(timeoutHandle);
        turn.recorder = undefined;
        work?.settle(workOutcome, { sessionId: turn.sessionId, ...(workReason ? { reason: workReason } : {}) });
        turn.work = undefined;
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
      }

      // Subsequent (queued) turns resume the now-known session and keep its
      // pin. turn.providerId is the resolved profile (set from initial routing
      // and re-pinned by session_info); carrying it forward stops a queued
      // follow-up from silently dropping onto the default profile/model/billing.
      resumeId = turn.sessionId ?? resumeId;
      profileId = turn.providerId ?? profileId;

      if (!turn.cancelled) next = dequeue();
    }
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
  { profileId: string; billingMode?: BillingMode; pricingRoute?: PricingRoute } | undefined
> {
  try {
    const providers = await registry.listAllProviders({ includeHidden: true });
    const resolved = profileId
      ? providers.find((provider) => provider.id === profileId)
      : providers.find((provider) => provider.backendId === backendId);
    if (!resolved) return undefined;
    return {
      profileId: resolved.id,
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
  // Accepted: it takes the session's next revision before it joins the queue.
  const revision = acceptRequest(host, sessionId, entry.requestId, host.catalog.getStoredBackendId(sessionId));
  if (revision !== undefined) entry.revision = revision;
  entry.followUpId = crypto.randomUUID();
  entry.queuedAt = Date.now();
  slot.queue.push(entry);
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
    });
    // Inject natively only into a turn that has not streamed its result yet,
    // and never ahead of older messages queued during routing. Host work never
    // joins a running turn, and nothing joins a running host-work turn: each
    // needs its own turn identity to correlate its result (and keep its own
    // posture), and a follow-up would merge two requests (#957).
    // Only into a turn the backend already holds, too: `startedAt` is set as
    // the turn is handed to startTurn and cleared once that returns. Before
    // then the slot is still resolving billing and the failure snapshot,
    // a resumed or dequeued turn included, and the backend has no turn to
    // inject into, so the message queues as the next turn instead (#1063).
    if (backend.capabilities.followUp && backend.followUp && runningTurn.startedAt !== undefined && runningTurn.lastResult === null && runningTurn.queue.length === 0 && thinkingLevel === undefined && requestId === undefined && draftRef === undefined && work === undefined && runningTurn.work === undefined) {
      // Inject into the running turn; frames flow through its bridge. The
      // device snapshot is deliberately not forwarded: a follow-up joins a
      // turn whose system prompt was already built and cannot be revised.
      host.catalog.clearRetryRequest?.(sessionId);
      runningTurn.retryRequest = undefined;
      const recorder = runningTurn.recorder;
      // Recorded before the hand-off: the running turn's own prompt was
      // recorded before its startTurn, so identical texts keep their order.
      host.catalog.recordMessageSource?.(sessionId, text, source ?? "typed", { turnId: runningTurn.turnId, files });
      const exchanges = host.catalog.takePendingLocalExchanges?.(sessionId) ?? [];
      const prompt = withLocalContext(withTrackFiles(text, files), exchanges);
      void (async () => {
        const releaseFollowUp = authorization.retain();
        try {
          await backend.followUp!({ sessionId, prompt, attachments });
          // Only one that joined is the turn's follow-up; a refused one
          // becomes its own turn.
          recorder?.recordFollowUp(authorization.principalId);
        } catch (err) {
          // The backend's turn can end before the host learns it has, for
          // example when its input closes while it holds a result. The
          // contract's "no running turn" refusal then means "run it next",
          // like any message sent between turns (#1063).
          const slot = err instanceof BackendRequestError
            ? (coordinator.startingBySession.get(sessionId) ?? coordinator.bySession.get(sessionId))
            : undefined;
          if (slot && !slot.cancelled) {
            queueFollowUp(host, ws, sessionId, slot, { ...followUpEntry(), refusedFollowUp: { exchanges } });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          host.reportTurnFailed("FOLLOWUP_FAILED", runningTurn, message);
          host.sendToClients(
            withTurnScope({ type: "error", code: "FOLLOWUP_FAILED", message }, runningTurn)
          );
        } finally {
          releaseFollowUp();
        }
      })();
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
    sessionId,
    attachments,
    ...(files?.length ? { files } : {}),
    providerId: requestedProviderId,
    ...(client ? { client } : {}),
    ...(source ? { source } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(requestId ? { requestId } : {}),
    ...(draftId ? { draftId } : {}),
    ...(draftRef ? { draftRef } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(!sessionId && localExchanges?.length ? { localExchanges } : {}),
    ...(!sessionId && msg.handoffHooks ? { handoffHooks: msg.handoffHooks } : {}),
    ...(work ? { work } : {}),
  });
}
