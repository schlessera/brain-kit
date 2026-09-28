import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type {
  MessageSource,
  ServerResultMessage,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/protocol";

import { attachMessageSources, saveMessageSource } from "./message-sources.js";

/**
 * Persistence seam for session ownership + accounting. The ws coordinator only
 * talks to this interface — swapping the store means implementing its
 * methods, not editing the turn loop.
 */
export interface SessionCatalog {
  /** The provider/profile a stored session is pinned to, or null. */
  getStoredProviderId(sessionId: string): string | null;
  /** The backend that owns a stored session, or null for legacy/unknown rows. */
  getStoredBackendId(sessionId: string): string | null;
  /**
   * Persist session ownership as soon as `session_info` names the session,
   * with zero cost/turn deltas — the terminal `result` adds the accounting.
   * Without this, a failed or cancelled first turn left the transcript
   * unowned.
   */
  persistSessionStub(
    sessionId: string,
    promptText: string,
    providerId: string | null,
    backendId: string
  ): void;
  /** Persist session accounting on the terminal `result` frame. */
  persistSession(
    msg: ServerResultMessage,
    promptText: string,
    providerId: string | null,
    backendId: string
  ): void;
  /**
   * Record how a user message was produced, at the moment its text is handed
   * to the backend for a known session, so replay can say so again. Optional
   * so a catalog written before it still type-checks; without it every
   * replayed message reads as typed.
   */
  recordMessageSource?(sessionId: string, text: string, source: MessageSource): void;
  /** Replayed history with each user message's recorded source joined on. */
  attachMessageSources?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
}

const UPSERT_SESSION_SQL = `INSERT INTO sessions (id, title, created_at, last_active_at, total_cost_usd, num_turns, provider_id, backend_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     last_active_at = excluded.last_active_at,
     total_cost_usd = total_cost_usd + excluded.total_cost_usd,
     num_turns = num_turns + excluded.num_turns,
     provider_id = COALESCE(excluded.provider_id, provider_id),
     backend_id = COALESCE(excluded.backend_id, backend_id)`;

/** SQLite-backed catalog over the app's own database (injected by createApp). */
export function createSessionCatalog(db: () => Database, log?: Logger): SessionCatalog {
  // Persistence stays non-throwing — losing one accounting row must not kill
  // the turn — but never silent: a full disk or locked database would
  // otherwise drop every session record with nothing anywhere.
  const reportWriteFailure = (sessionId: string, err: unknown): void => {
    log?.emit({
      severityText: "WARN",
      body: "session persistence failed",
      attributes: {
        "session.id": sessionId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  };
  return {
    getStoredProviderId(sessionId) {
      const row = db()
        .query("SELECT provider_id AS providerId FROM sessions WHERE id = ?")
        .get(sessionId) as { providerId: string | null } | null;
      return row?.providerId ?? null;
    },

    getStoredBackendId(sessionId) {
      const row = db()
        .query("SELECT backend_id AS backendId FROM sessions WHERE id = ?")
        .get(sessionId) as { backendId: string | null } | null;
      return row?.backendId ?? null;
    },

    persistSessionStub(sessionId, promptText, providerId, backendId) {
      try {
        db()
          .prepare(UPSERT_SESSION_SQL)
          .run(
            sessionId,
            promptText.slice(0, 100),
            Date.now(),
            Date.now(),
            0,
            0,
            providerId,
            backendId
          );
      } catch (err) {
        reportWriteFailure(sessionId, err);
      }
    },

    persistSession(msg, promptText, providerId, backendId) {
      try {
        db()
          .prepare(UPSERT_SESSION_SQL)
          .run(
            msg.sessionId,
            promptText.slice(0, 100),
            Date.now(),
            Date.now(),
            // costUsd is optional (rev 2): absent = unknown, accounted as 0.
            msg.costUsd ?? 0,
            msg.numTurns,
            providerId,
            backendId
          );
      } catch (err) {
        reportWriteFailure(msg.sessionId, err);
      }
    },

    recordMessageSource(sessionId, text, source) {
      try {
        saveMessageSource(db(), sessionId, text, source);
      } catch (err) {
        reportWriteFailure(sessionId, err);
      }
    },

    attachMessageSources(sessionId, messages) {
      try {
        return attachMessageSources(db(), sessionId, messages);
      } catch (err) {
        // A replay without sources renders every message as typed, which is
        // what it rendered before sources were kept; losing the history over
        // it would not be.
        log?.emit({
          severityText: "WARN",
          body: "message sources could not be joined onto history",
          attributes: {
            "session.id": sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        return messages;
      }
    },
  };
}
