import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { type WSContext, sendTo } from "./clients.js";
import { HISTORY_CHUNK_BYTES, shrinkForReplication } from "./shrink.js";

/**
 * Send a structured history to one socket as one or more `session_history`
 * frames. Each message is size-bounded, then batched into byte-limited chunks
 * so no single frame exceeds the socket's per-message limit (which would drop
 * the connection and wedge the reconnect loop). The first frame replaces the
 * client transcript; continuation frames carry `append: true`. An empty
 * history still emits one (empty, replacing) frame so the client settles.
 *
 * Every frame carries `sessionId` so a client with multiple sessions open can
 * demux it: a history load for a background session must never replace the
 * transcript in view (a reconnect or an out-of-order getHistory otherwise
 * silently overwrites the wrong pane).
 */
export function sendSessionHistory(
  ws: WSContext,
  sessionId: string,
  messages: SessionHistoryMessage[]
): void {
  const bounded = messages.map((m) => shrinkForReplication(m));
  if (bounded.length === 0) {
    sendTo(ws, { type: "session_history", sessionId, messages: [] });
    return;
  }

  let batch: SessionHistoryMessage[] = [];
  let batchBytes = 0;
  let isFirst = true;
  const flush = () => {
    sendTo(ws, {
      type: "session_history",
      sessionId,
      messages: batch,
      ...(isFirst ? {} : { append: true }),
    });
    isFirst = false;
    batch = [];
    batchBytes = 0;
  };

  for (const message of bounded) {
    const size = JSON.stringify(message).length;
    if (batch.length > 0 && batchBytes + size > HISTORY_CHUNK_BYTES) flush();
    batch.push(message);
    batchBytes += size;
  }
  flush();
}
