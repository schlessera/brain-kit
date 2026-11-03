import { createTurnLifecycle } from "../activity/turn-lifecycle.js";
import { withTrackFiles } from "../tracks/read.js";
import type {
  ChatImageAttachment,
  ClientEnvironment,
  DraftRef,
  LocalExchange,
  MessageSource,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "./clients.js";
import { withSessionId, withTurnScope } from "./frames.js";
import { withLocalContext } from "./local-exchanges.js";
import { acceptDraft } from "./drafts.js";
import { acceptRequest } from "./recovery.js";
import type { AuthorizationContext, HostWork, QueuedFollowUp, RunningTurn } from "./turns.js";
import { queuedBytes, queuedFollowUpBytes } from "./turns.js";
import type { WsHost } from "./host.js";
import { MAX_SESSION_QUEUE, QUEUE_MAX_BYTES, QUEUE_WARN_BYTES } from "./limits.js";
import { emitTurnError } from "./bridge.js";
import { resolveTurnTarget } from "./routing.js";
import {
  beginSlotStart,
  bindRequest,
  closeSessionSlot,
  dequeueRequest,
  dropHandedOver,
  firstRequest,
  registerSessionSlot,
  releaseActive,
  reportRoutingFailure,
  requestLifecycle,
} from "./session-run/slot.js";
import { publishTurnStatus } from "./session-run/teardown.js";
import { runSlotTurn } from "./session-run/turn.js";
import type { HandoffHooks, RunSessionInput, TurnLifecycle } from "./session-run/types.js";
import { REVOKED_REASON } from "./turns.js";

export { resolveRunBilling } from "./session-run/billing.js";
export type { HandoffHooks } from "./session-run/types.js";

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
 * Run one session slot: the initial turn, then any queued follow-up turns in
 * order. The host owns per-turn cancellation (AbortController + timeout). Never
 * throws — runtime failures are emitted as error frames.
 */
export async function runSession(host: WsHost, initial: RunSessionInput): Promise<void> {
  if (host.closing) throw new Error("The host is shutting down; no new turn was started.");
  const turnId = crypto.randomUUID();
  if(initial.historyOwnerId && initial.authorization.valid) host.dialogue.adoptTurn(turnId,initial.historyOwnerId,initial.authorization.principalId);
  const releaseAuthorization = initial.authorization.retain();
  const lifecycle = host.activity ? createTurnLifecycle(host.activity.store, turnId, initial.sessionId ?? null, Date.now(), () => host.activity!.stream.pump()) : undefined;
  const task = runRetainedSession(host, initial, turnId, lifecycle);
  host.turnTasks.add(task);
  try {
    await task;
  } catch (error) {
    lifecycle?.finish("error", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    host.dialogue.retireTurn(turnId);
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

/**
 * The slot's lifecycle: setup, then each request in queue order, then
 * teardown. Each request is bound to the slot, run as one turn
 * (`session-run/turn.ts`), and the slot advances to the session and profile
 * that turn left behind. Every state transition the slot makes between two
 * awaits runs in one synchronous step here: routing's end and the turn's
 * registration, and a turn's result and the next dequeue or the slot's close.
 */
async function runRetainedSession(
  host: WsHost,
  initial: RunSessionInput,
  initialTurnId: string,
  initialLifecycle: TurnLifecycle | undefined
): Promise<void> {
  const starting = beginSlotStart(host, initial);
  let target: Awaited<ReturnType<typeof resolveTurnTarget>>;
  try {
    target = await resolveTurnTarget(host.registry, host.catalog, initial.sessionId, initial.providerId);
  } catch (err) {
    reportRoutingFailure(host, initial, starting, err, initialLifecycle);
    return;
  } finally {
    host.coordinator.endStarting(initial.sessionId, starting);
  }
  const slot = registerSessionSlot(host, initial, starting, target, initialTurnId);
  if (!slot) return;
  const { turn } = slot;
  let next: QueuedFollowUp | null = firstRequest(initial);
  let activeLifecycle = initialLifecycle;
  try {
    while (next && !turn.cancelled) {
      const current: QueuedFollowUp = next;
      const lifecycle = requestLifecycle(slot, current, initialLifecycle);
      activeLifecycle = lifecycle;
      if (current.queuedAt !== undefined) lifecycle?.mark("dequeuedAt");
      slot.releaseActive = current.releaseAuthorization;
      if (bindRequest(slot, current, lifecycle) === "revoked") {
        dropHandedOver(slot, current, REVOKED_REASON);
        next = dequeueRequest(turn);
        continue;
      }
      next = null;
      const result = await runSlotTurn(slot, current, lifecycle);
      if (result.kind === "denied") {
        const { error } = result;
        lifecycle?.finish("denied", error instanceof Error ? error.message : String(error));
        emitTurnError(host, turn, error);
        current.work?.settle("error", { reason: error instanceof Error ? error.message : String(error) });
        break;
      }
      if (result.kind === "revoked") {
        lifecycle?.finish("cancelled", REVOKED_REASON);
        releaseActive(slot);
        dropHandedOver(slot, current, REVOKED_REASON);
        next = dequeueRequest(turn);
        continue;
      }
      publishTurnStatus(slot, result.outcome);

      // Subsequent (queued) turns resume the now-known session and keep its
      // pin. turn.providerId is the resolved profile (set from initial routing
      // and re-pinned by session_info); carrying it forward stops a queued
      // follow-up from silently dropping onto the default profile/model/billing.
      slot.resumeId = turn.sessionId ?? slot.resumeId;
      slot.profileId = turn.providerId ?? slot.profileId;

      // A live follow-up still being delivered may yet be refused and rejoin
      // the queue ahead of the messages sent after it: let it settle before
      // the next of those starts (#1063). With nothing queued the slot ends
      // as before; a delivery may outlive its turn.
      if (!turn.cancelled && turn.queue.length > 0) await settleDeliveries(turn);
      if (!turn.cancelled) next = dequeueRequest(turn);
    }
  } catch (error) {
    activeLifecycle?.finish(turn.cancelled ? "cancelled" : turn.abortController?.signal.aborted ? "timeout" : "error",
      error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    closeSessionSlot(slot, next);
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
    historyOwnerId?: string;
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
      // Recorded now, so the prompt handed over next takes it; answered once stored (#2850).
      void (host.catalog.recordLocalExchange?.(sessionId, exchange, false) ?? Promise.resolve(false)).then(saved => host.sendMessage(ws, {
        type: "local_exchange_result",
        sessionId,
        exchangeId: exchange.id,
        saved,
        ...(saved ? {} : { reason: "The server could not store it." }),
      }));
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
  const running = runSession(host, {
    authorization,
    ...(msg.replayPrompt !== undefined ? { replayPrompt: msg.replayPrompt } : {}),
    ...(msg.isRetry ? { isRetry: true } : {}),
    text,
    ...(msg.shareId ? { shareId: msg.shareId } : {}),
    ...(msg.historyOwnerId && !sessionId ? {historyOwnerId:msg.historyOwnerId} : {}),
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
  if(msg.historyOwnerId) void running.catch(()=>host.sendMessage(ws,{type:"error",code:"DIALOGUE_UNAVAILABLE",...(requestId?{requestId}:{}),message:"Retained conversation could not be adopted. Check task status before trying again."}));
  else void running;
}
