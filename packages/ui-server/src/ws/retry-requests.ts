import type { Database } from "bun:sqlite";
import type { ClientChatMessage, ServerRetryReceipt, SessionHistoryMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { clientChatMessageSchema } from "@schlessera/brain-ui-sdk/schemas";

export interface RetainedRetry {
  turnId: string;
  principalId: string;
  request: ClientChatMessage;
  failureMessage: string;
  prompt: string;
}

/** One eligible original per session. The next accepted input removes its bytes. */
export function saveRetryRequest(db: Database, sessionId: string, turnId: string, principalId: string, request: ClientChatMessage, prompt: string, failure: TurnFailure) {
  db.prepare(`INSERT INTO retry_requests (session_id, turn_id, principal_id, request_json, prompt, failure_message)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET turn_id=excluded.turn_id,
    principal_id=excluded.principal_id, request_json=excluded.request_json, prompt=excluded.prompt, failure_message=excluded.failure_message`)
    .run(sessionId, turnId, principalId, JSON.stringify(request), prompt, failure.message);
}

export function clearRetryRequest(db: Database, sessionId: string) {
  db.prepare("DELETE FROM retry_requests WHERE session_id = ?").run(sessionId);
}

function retained(db: Database, sessionId: string): RetainedRetry | null {
  const row = db.query("SELECT turn_id, principal_id, request_json, prompt, failure_message FROM retry_requests WHERE session_id = ?")
    .get(sessionId) as { turn_id: string; principal_id: string; request_json: string; prompt: string; failure_message: string } | null;
  if (!row) return null;
  try {
    const parsed = clientChatMessageSchema.safeParse(JSON.parse(row.request_json));
    if (!parsed.success) return null;
    return { turnId: row.turn_id, principalId: row.principal_id, request: parsed.data, failureMessage: row.failure_message, prompt: row.prompt };
  } catch { return null; }
}

/** Receipt identity is bound to the caller and session; no original prompt in status queries. */
export function retryReceipt(db: Database, sessionId: string, requestId: string, principalId: string): ServerRetryReceipt {
  const row = db.query("SELECT state FROM retry_receipts WHERE session_id = ? AND request_id = ? AND principal_id = ?")
    .get(sessionId, requestId, principalId) as { state: "accepted" | "refused" } | null;
  return { type: "retry_receipt", sessionId, requestId, state: row?.state ?? "unknown" };
}

/** Refusals also remain queryable if their immediate acknowledgement is lost. */
export function refuseRetry(db: Database, sessionId: string, requestId: string, principalId: string, message: string): ServerRetryReceipt {
  db.prepare("INSERT OR IGNORE INTO retry_receipts (request_id, session_id, principal_id, state) VALUES (?, ?, ?, 'refused')")
    .run(requestId, sessionId, principalId);
  const receipt = retryReceipt(db, sessionId, requestId, principalId);
  return receipt.state === "accepted" ? receipt : { ...receipt, state: "refused", message };
}

/** Persist receipt and consume eligibility atomically BEFORE dispatch. A duplicate never dispatches again. */
export function reserveRetry(db: Database, sessionId: string, failedTurnId: string, requestId: string, principalId: string): { receipt: ServerRetryReceipt; request?: ClientChatMessage; prompt?: string } {
  return db.transaction(() => {
    const existing = retryReceipt(db, sessionId, requestId, principalId);
    if (existing.state !== "unknown") return { receipt: existing };
    // Reject collisions with another caller too, without revealing its receipt.
    if (db.query("SELECT 1 FROM retry_receipts WHERE request_id = ?").get(requestId)) {
      return { receipt: { ...existing, state: "refused" as const, message: "This retry request cannot be used." } };
    }
    const original = retained(db, sessionId);
    if (!original || original.turnId !== failedTurnId || original.principalId !== principalId) {
      return { receipt: refuseRetry(db, sessionId, requestId, principalId, "The original request is unavailable or is no longer the latest turn.") };
    }
    const request = { ...original.request, sessionId };
    db.prepare("INSERT INTO retry_receipts (request_id, session_id, principal_id, state) VALUES (?, ?, ?, 'accepted')")
      .run(requestId, sessionId, principalId);
    clearRetryRequest(db, sessionId);
    return { receipt: retryReceipt(db, sessionId, requestId, principalId), request, prompt: original.prompt };
  }).immediate();
}

/** Only the latest matching failure receives a handle; historical cards cannot resend. */
export function attachRetryRequest(db: Database, sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
  const original = retained(db, sessionId);
  const last = messages.at(-1);
  if (!original || last?.role !== "assistant" || !last.failure || last.failure.message !== original.failureMessage) return messages;
  return [...messages.slice(0, -1), { ...last, retryOfTurnId: original.turnId }];
}
