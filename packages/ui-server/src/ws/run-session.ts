import type { ChatImageAttachment } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import { withSessionId, withTurnScope } from "./frames.js";
import { makeBridge, emitTurnError } from "./bridge.js";
import { resolveTurnTarget } from "./routing.js";
import type { QueuedFollowUp, RunningTurn } from "./turns.js";
import { MAX_SESSION_QUEUE, type WsHost } from "./host.js";

/**
 * Run one session slot: the initial turn, then any queued follow-up turns in
 * order. The host owns per-turn cancellation (AbortController + timeout). Never
 * throws — runtime failures are emitted as error frames.
 */
export async function runSession(
  host: WsHost,
  initial: {
    text: string;
    sessionId?: string;
    attachments: ChatImageAttachment[];
    providerId?: string;
  }
): Promise<void> {
  const { coordinator } = host;
  coordinator.startingSessions += 1;
  let target: Awaited<ReturnType<typeof resolveTurnTarget>>;
  try {
    target = await resolveTurnTarget(host.catalog, initial.sessionId, initial.providerId);
  } catch (err) {
    host.sendToClients({
      type: "error",
      code: "BACKEND_ERROR",
      message: err instanceof Error ? err.message : String(err),
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
    });
    return;
  } finally {
    coordinator.startingSessions = Math.max(0, coordinator.startingSessions - 1);
  }

  const { backend, profileId: initialProfileId } = target;
  if (target.droppedPin) {
    console.warn(
      `[agent] session ${initial.sessionId} pinned profile "${target.droppedPin}" ` +
        `is unavailable; running on the default profile.`
    );
    host.sendToClients({
      type: "status",
      status: "thinking",
      detail: `Pinned model "${target.droppedPin}" is unavailable — running on the default.`,
      ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
    });
  }
  const turn: RunningTurn = {
    sessionId: initial.sessionId ?? null,
    turnId: crypto.randomUUID(),
    providerId: initialProfileId ?? null,
    backend,
    abortController: new AbortController(),
    timeoutHandle: setTimeout(() => {}, 0),
    queue: [],
    cancelled: false,
  };
  clearTimeout(turn.timeoutHandle);
  coordinator.running.add(turn);
  if (turn.sessionId) coordinator.bySession.set(turn.sessionId, turn);

  let profileId = initialProfileId;
  let resumeId = initial.sessionId;
  let next: QueuedFollowUp | null = {
    text: initial.text,
    attachments: initial.attachments,
  };

  try {
    while (next && !turn.cancelled) {
      const { text, attachments } = next;
      next = null;

      const abortController = new AbortController();
      turn.abortController = abortController;
      const timeoutHandle = setTimeout(() => {
        console.log("[agent] Turn timed out after", host.turnTimeoutMs, "ms");
        abortController.abort();
        // Reject any pending interactive request for this turn too. A bridge
        // that awaits askUser/approval without racing the abort signal would
        // otherwise leave startTurn parked forever after abort(), leaking a
        // concurrency slot until restart. Draining unblocks the unwind.
        coordinator.drainPendingForTurn(turn, "Turn timed out");
      }, host.turnTimeoutMs);
      turn.timeoutHandle = timeoutHandle;

      const bridge = makeBridge(host, turn, text, backend.id);
      try {
        await backend.startTurn({
          prompt: text,
          attachments,
          sessionId: resumeId,
          profileId,
          signal: abortController.signal,
          bridge,
        });
      } catch (err) {
        emitTurnError(host, turn, err);
      } finally {
        clearTimeout(timeoutHandle);
      }

      // Subsequent (queued) turns resume the now-known session and keep its
      // pin. turn.providerId is the resolved profile (set from initial routing
      // and re-pinned by session_info); carrying it forward stops a queued
      // follow-up from silently dropping onto the default profile/model/billing.
      resumeId = turn.sessionId ?? resumeId;
      profileId = turn.providerId ?? profileId;

      if (!turn.cancelled && turn.queue.length > 0) {
        next = turn.queue.shift()!;
        // A queued follow-up is its own turn — give it a fresh identity.
        turn.turnId = crypto.randomUUID();
      }
    }
  } finally {
    if (turn.sessionId) coordinator.bySession.delete(turn.sessionId);
    coordinator.running.delete(turn);
    coordinator.drainPendingForTurn(turn, "Session ended");
  }
}

/** Dispatch a chat_message: follow-up to a running session, or a new session. */
export async function handleChatMessage(
  host: WsHost,
  ws: WSContext,
  text: string,
  sessionId: string | undefined,
  attachments: ChatImageAttachment[],
  requestedProviderId: string | undefined
): Promise<void> {
  const { coordinator } = host;
  const runningTurn = sessionId ? coordinator.bySession.get(sessionId) : undefined;

  if (runningTurn && sessionId) {
    const backend = runningTurn.backend;
    // Message to a session whose turn is running = a follow-up.
    if (backend.capabilities.followUp && backend.followUp) {
      // Inject into the running turn; frames flow through its bridge.
      backend.followUp({ sessionId, prompt: text, attachments }).catch((err) => {
        host.sendToClients(
          withTurnScope(
            { type: "error", code: "FOLLOWUP_FAILED", message: err instanceof Error ? err.message : String(err) },
            runningTurn
          )
        );
      });
    } else if (runningTurn.queue.length >= MAX_SESSION_QUEUE) {
      host.sendMessage(
        ws,
        // Session-scoped only: the rejected message would have become a
        // FUTURE turn in this slot, not the one currently running.
        withSessionId(
          { type: "error", code: "SESSION_QUEUE_FULL", message: `This session's queue is full (max ${MAX_SESSION_QUEUE}). Wait for it to catch up.` },
          sessionId
        )
      );
    } else {
      // Queue it as the session's next turn; report queued immediately.
      runningTurn.queue.push({ text, attachments });
      host.sendToClients(withSessionId({ type: "status", status: "queued" }, sessionId));
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
    text,
    sessionId,
    attachments,
    providerId: requestedProviderId,
  });
}
