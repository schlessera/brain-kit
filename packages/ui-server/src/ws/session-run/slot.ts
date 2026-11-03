import { createTurnLifecycle } from "../../activity/turn-lifecycle.js";
import type { WsHost } from "../host.js";
import { resolveTurnTarget } from "../routing.js";
import type { QueuedFollowUp, RunningTurn, StartingSession } from "../turns.js";
import { REVOKED_REASON } from "../turns.js";
import type { RunSessionInput, SessionSlot, TurnLifecycle } from "./types.js";

/** Why a follow-up leaves when its session's slot ends without running it (#1002). */
export const SLOT_ENDED_REASON = "The session stopped before it ran.";

/**
 * Route a new slot and register its turn. Messages that arrive while routing
 * queue on the starting session and become the turn's queue. Resolves
 * undefined when the slot ends before any turn: routing failed (reported
 * here), the start was cancelled, the host is closing, or the principal was
 * revoked.
 */
export async function openSessionSlot(
  host: WsHost,
  initial: RunSessionInput,
  initialTurnId: string,
  initialLifecycle: TurnLifecycle | undefined
): Promise<SessionSlot | undefined> {
  const { coordinator } = host;
  const starting: StartingSession = {
    queue: [],
    cancelled: false,
    ...(initial.revision !== undefined ? { revision: initial.revision } : {}),
  };
  coordinator.beginStarting(initial.sessionId, starting);
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
    return undefined;
  } finally {
    coordinator.endStarting(initial.sessionId, starting);
  }

  if (starting.cancelled || host.closing) {
    for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    return undefined;
  }
  if (!initial.authorization.valid) {
    if (initial.sessionId) coordinator.dropStartingQueue(initial.sessionId, starting, REVOKED_REASON);
    else for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
    return undefined;
  }

  const { backend, profileId } = target;
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
    providerId: profileId ?? null,
    backend,
    abortController: new AbortController(),
    timeoutHandle: setTimeout(() => {}, 0),
    queue: starting.queue,
    pendingCancellationPrincipalIds: [],
    cancelled: false,
    lastResult: null,
  };
  turn.shareId = initial.shareId;
  clearTimeout(turn.timeoutHandle);
  coordinator.registerTurn(turn);
  return {
    host,
    initial,
    turn,
    backend,
    firstTurnId: turn.turnId,
    profileId,
    resumeId: initial.sessionId,
    draftExchanges: initial.sessionId ? [] : (initial.localExchanges ?? []),
    releaseActive: undefined,
  };
}

/** The slot's first request, as a queue entry whose lease settles its work. */
export function firstRequest(initial: RunSessionInput): QueuedFollowUp {
  return {
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
}

/**
 * The lifecycle a request's turn reports on: the slot's own for its first
 * turn, the one the queue created for a follow-up, or a new one.
 */
export function requestLifecycle(
  slot: SessionSlot,
  current: QueuedFollowUp,
  initialLifecycle: TurnLifecycle | undefined
): TurnLifecycle | undefined {
  const { host, turn } = slot;
  if (turn.turnId === slot.firstTurnId) return initialLifecycle;
  return current.lifecycle ?? (host.activity
    ? createTurnLifecycle(host.activity.store, turn.turnId, turn.sessionId, current.queuedAt ?? Date.now(), () => host.activity!.stream.pump())
    : undefined);
}

/**
 * Bind the slot to the request it now holds; recovery reads it as queued
 * until its turn is handed to the backend (#964). A request whose principal
 * is no longer valid is released instead, and the slot moves on.
 */
export function bindRequest(slot: SessionSlot, current: QueuedFollowUp, lifecycle: TurnLifecycle | undefined): "bound" | "revoked" {
  const { host, turn } = slot;
  turn.revision = current.revision;
  turn.startedAt = undefined;
  turn.principalId = current.principalId;
  turn.authorization = current.authorization;
  if (!turn.authorization.valid) {
    lifecycle?.finish("cancelled", REVOKED_REASON);
    releaseActive(slot);
    host.budgets?.end(turn.turnId);
    turn.revision = undefined;
    return "revoked";
  }
  turn.requestId = current.requestId;
  turn.draftRef = current.draftRef;
  turn.work = current.work;
  return "bound";
}

/** Release the running request's queue lease, once. */
export function releaseActive(slot: SessionSlot): void {
  slot.releaseActive!();
  slot.releaseActive = undefined;
}

/**
 * Take the next queued follow-up. It stays pending, as `handingOver`, until
 * its turn reaches the backend (#1002).
 */
export function dequeueRequest(turn: RunningTurn): QueuedFollowUp | null {
  const entry = turn.queue.shift() ?? null;
  turn.handingOver = entry ?? undefined;
  if (entry) {
    // A queued follow-up is its own turn — give it a fresh identity, and
    // its own terminal disposition.
    turn.turnId = entry.lifecycleTurnId ?? crypto.randomUUID();
    turn.lastResult = null;
  }
  return entry;
}

/** A handed-over entry that will not run leaves the pending list with why. */
export function dropHandedOver(slot: SessionSlot, entry: QueuedFollowUp, reason: string): void {
  const { turn } = slot;
  if (turn.handingOver !== entry) return;
  turn.handingOver = undefined;
  slot.host.coordinator.queueChanged(turn.sessionId, { dropped: { entries: [entry], reason } });
}

/**
 * End the slot. Whatever is still pending will never run in it: every lease
 * is released, the pending list learns why, and the turn leaves the
 * coordinator with its pending requests drained.
 */
export function closeSessionSlot(slot: SessionSlot, next: QueuedFollowUp | null): void {
  const { host: { coordinator }, turn } = slot;
  slot.releaseActive?.();
  next?.releaseAuthorization();
  // A handed-over entry's lease is `next`'s or the active one, both released above.
  const unstarted = turn.handingOver;
  turn.handingOver = undefined;
  const queued = turn.queue.splice(0);
  for (const entry of queued) entry.releaseAuthorization();
  coordinator.queueChanged(turn.sessionId, {
    dropped: { entries: unstarted ? [unstarted, ...queued] : queued, reason: SLOT_ENDED_REASON },
  });
  coordinator.unregisterTurn(turn);
  coordinator.drainPendingForTurn(turn, "Session ended");
}
