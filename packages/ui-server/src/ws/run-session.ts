import type {
  BillingMode,
  ChatImageAttachment,
  ClientEnvironment,
  LocalExchange,
  MessageSource,
  PricingRoute,
} from "@schlessera/brain-ui-sdk/protocol";
import type { BackendRegistry } from "../agent/backend.js";
import type { WSContext } from "./clients.js";
import { withSessionId, withTurnScope } from "./frames.js";
import { makeBridge, emitTurnError } from "./bridge.js";
import { createTurnRecorder, type TurnRecorder } from "../activity/recorder.js";
import { resolveTurnTarget } from "./routing.js";
import { withLocalContext } from "./local-exchanges.js";
import type { AuthorizationContext, QueuedFollowUp, RunningTurn } from "./turns.js";
import { queuedBytes, queuedFollowUpBytes } from "./turns.js";
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
  text: string;
  sessionId?: string;
  attachments: ChatImageAttachment[];
  providerId?: string;
  client?: ClientEnvironment;
  source?: MessageSource;
  /** Client correlation id for a new conversation; echoed on session_info. */
  draftId?: string;
  /**
   * Local exchanges the draft conversation holds (#582). Recorded against
   * the session once `session_info` names it, and carried on its first
   * prompt.
   */
  localExchanges?: LocalExchange[];
};

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
    releaseAuthorization();
  }
}

async function runRetainedSession(
  host: WsHost,
  initial: RunSessionInput
): Promise<void> {
  const { coordinator } = host;
  const starting = { queue: [] as QueuedFollowUp[], cancelled: false };
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
    host.sendToClients({
      type: "error",
      code: "BACKEND_ERROR",
      message,
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
    });
    return;
  } finally {
    coordinator.startingSessions = Math.max(0, coordinator.startingSessions - 1);
    if (initial.sessionId && coordinator.startingBySession.get(initial.sessionId) === starting) {
      coordinator.startingBySession.delete(initial.sessionId);
    }
  }

  if (starting.cancelled) return;
  if (!initial.authorization.valid) return;

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
    ...(initial.client ? { client: initial.client } : {}),
    ...(initial.source ? { source: initial.source } : {}),
    releaseAuthorization: () => {},
  };
  let releaseActiveAuthorization: (() => void) | undefined;

  try {
    while (next && !turn.cancelled) {
      releaseActiveAuthorization = next.releaseAuthorization;
      turn.principalId = next.principalId;
      turn.authorization = next.authorization;
      if (!turn.authorization.valid) {
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        next = turn.queue.shift() ?? null;
        if (next) {
          turn.turnId = crypto.randomUUID();
          turn.lastResult = null;
        }
        continue;
      }
      const { text, attachments, client, source } = next;
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
        clearTimeout(timeoutHandle);
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
        // A cancellation accepted while billing was in flight is already a
        // decision someone made; losing it because the turn's own principal
        // was revoked a moment later would erase the actor, not the turn. Drain
        // the buffer before leaving.
        recordPendingCancellations(host, turn, billing);
        if (turn.queue.length > 0) {
          next = turn.queue.shift()!;
          turn.turnId = crypto.randomUUID();
          turn.lastResult = null;
        }
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
        host.catalog.recordMessageSource?.(sid, text, source ?? "typed");
      if (resumeId) recordSource(resumeId);
      // Locally answered commands the agent has not seen yet ride on this
      // prompt (#582), taken here, past the last await, so an exchange is
      // only marked carried by a prompt that is actually handed over. The
      // source above is recorded for the user's text alone, which is what
      // replay matches once the context is stripped again.
      const drafted = draftExchanges;
      draftExchanges = [];
      const prompt = withLocalContext(text, [
        ...drafted,
        ...(resumeId ? (host.catalog.takePendingLocalExchanges?.(resumeId) ?? []) : []),
      ]);
      const bridge = makeBridge(
        host,
        turn,
        text,
        backend.id,
        recorder,
        resumeId
          ? undefined
          : (sid) => {
              recordSource(sid);
              recordDraftExchanges(host, sid, drafted);
            }
      );
      const startedAt = Date.now();
      host.reportTurnStarted(turn);
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
        });
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
      } finally {
        clearTimeout(timeoutHandle);
        turn.recorder = undefined;
        releaseActiveAuthorization();
        releaseActiveAuthorization = undefined;
      }

      // Subsequent (queued) turns resume the now-known session and keep its
      // pin. turn.providerId is the resolved profile (set from initial routing
      // and re-pinned by session_info); carrying it forward stops a queued
      // follow-up from silently dropping onto the default profile/model/billing.
      resumeId = turn.sessionId ?? resumeId;
      profileId = turn.providerId ?? profileId;

      if (!turn.cancelled && turn.queue.length > 0) {
        next = turn.queue.shift()!;
        // A queued follow-up is its own turn — give it a fresh identity, and
        // its own terminal disposition.
        turn.turnId = crypto.randomUUID();
        turn.lastResult = null;
      }
    }
  } finally {
    releaseActiveAuthorization?.();
    next?.releaseAuthorization();
    for (const entry of turn.queue.splice(0)) entry.releaseAuthorization();
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
async function resolveRunBilling(
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
    entry.releaseAuthorization();
    return;
  }

  // Queue it as the session's next turn; report queued immediately.
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
    withSessionId({ type: "status", status: "queued", ...(detail ? { detail } : {}) }, sessionId)
  );
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
    providerId?: string;
    client?: ClientEnvironment;
    source?: MessageSource;
    draftId?: string;
    localExchanges?: LocalExchange[];
  }
): Promise<void> {
  const {
    authorization,
    text,
    attachments,
    sessionId,
    providerId: requestedProviderId,
    client,
    source,
    draftId,
    localExchanges,
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
      host.sendMessage(ws, { type: "error", code: "SESSION_BUSY", sessionId, message: "This session is cancelling. Wait before sending again." });
    } else {
      queueFollowUp(host, ws, sessionId, starting, {
        principalId: authorization.principalId,
        authorization,
        text,
        attachments,
        ...(client ? { client } : {}),
        ...(source ? { source } : {}),
        releaseAuthorization: authorization.retain(),
      });
    }
    return;
  }

  if (runningTurn && sessionId) {
    const backend = runningTurn.backend;
    // Drain older messages queued during routing before allowing native
    // injection to overtake them.
    if (backend.capabilities.followUp && backend.followUp && runningTurn.queue.length === 0) {
      // Inject into the running turn; frames flow through its bridge. The
      // device snapshot is deliberately not forwarded: a follow-up joins a
      // turn whose system prompt was already built and cannot be revised.
      runningTurn.recorder?.recordFollowUp(authorization.principalId);
      // Recorded before the hand-off: the running turn's own prompt was
      // recorded before its startTurn, so identical texts keep their order.
      host.catalog.recordMessageSource?.(sessionId, text, source ?? "typed");
      const prompt = withLocalContext(text, host.catalog.takePendingLocalExchanges?.(sessionId) ?? []);
      void (async () => {
        const releaseFollowUp = authorization.retain();
        try {
          await backend.followUp!({ sessionId, prompt, attachments });
        } catch (err) {
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
      queueFollowUp(host, ws, sessionId, runningTurn, {
        principalId: authorization.principalId,
        authorization,
        text,
        attachments,
        ...(client ? { client } : {}),
        ...(source ? { source } : {}),
        releaseAuthorization: authorization.retain(),
      });
    }
    return;
  }

  // New session (or resume of an idle one) — gated by the concurrency cap.
  const cap = host.maxConcurrentSessions();
  if (coordinator.running.size + coordinator.startingSessions >= cap) {
    host.sendMessage(ws, {
      type: "error",
      code: "SESSION_LIMIT",
      message: `Too many concurrent sessions (max ${cap}). Wait for one to finish.`,
      ...(sessionId ? { sessionId } : {}),
    });
    return;
  }

  if (sessionId) {
    host.sendToClients(withSessionId({ type: "status", status: "thinking" }, sessionId));
  }
  void runSession(host, {
    authorization,
    text,
    sessionId,
    attachments,
    providerId: requestedProviderId,
    ...(client ? { client } : {}),
    ...(source ? { source } : {}),
    ...(draftId ? { draftId } : {}),
    ...(!sessionId && localExchanges?.length ? { localExchanges } : {}),
  });
}
