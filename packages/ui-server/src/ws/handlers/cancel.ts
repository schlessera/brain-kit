import type { ClientMessageHandler } from "./context.js";

export const handleCancel: ClientMessageHandler<"cancel"> = ({ host, ws, connection }, msg) => {
  const { coordinator } = host;
  if (msg.sessionId) {
    const turn = coordinator.bySession.get(msg.sessionId);
    if (turn) {
      coordinator.recordCancellation(turn, connection.authorization.principalId);
      coordinator.cancelTurn(turn, "Cancelled by user");
    }
    // A cancel drops the session's queued follow-ups; a conversation's
    // committed-but-unsubmitted work in that session goes with them.
    host.conversations?.sessionCancelled(msg.sessionId);
    const starting = coordinator.startingBySession.get(msg.sessionId);
    if (starting) {
      starting.cancelled = true;
      // Releasing here, not in runSession: a start cancelled before it
      // becomes a turn never reaches the loop that would drain its queue.
      coordinator.dropStartingQueue(msg.sessionId, starting, "Cancelled by user");
      host.sendToClients({ type: "status", status: "idle", sessionId: msg.sessionId, detail: "Cancelled before starting" });
    }
    return;
  }
  // No sessionId: cancel the sole running session; ambiguous if several run.
  if (coordinator.running.size === 0) return;
  if (coordinator.running.size > 1) {
    host.sendMessage(ws, {
      type: "error",
      code: "CANCEL_AMBIGUOUS",
      message: "Several sessions are running — specify which to cancel.",
    });
    return;
  }
  const turn = [...coordinator.running][0]!;
  coordinator.recordCancellation(turn, connection.authorization.principalId);
  coordinator.cancelTurn(turn, "Cancelled by user");
  if (turn.sessionId) host.conversations?.sessionCancelled(turn.sessionId);
};
