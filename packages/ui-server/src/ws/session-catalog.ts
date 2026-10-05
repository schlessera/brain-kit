import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type {
  ClientChatMessage,
  TurnFailure,
  ServerRetryReceipt,
  LocalExchange,
  MessageSource,
  ServerResultMessage,
  SessionHistoryMessage,
  ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";

import { attachMessageSources, saveMessageSource, saveEffectiveThinkingLevel } from "./message-sources.js";
import {
  loadLocalExchanges,
  saveLocalExchange,
  takePendingLocalExchanges,
  type LocalExchangeRecord,
} from "./local-exchanges.js";

import * as retries from "./retry-requests.js";
import { attachTurnFailures, saveTurnFailure, type RecordedTurnFailure } from "./turn-failures.js";

/**
 * Persistence seam for session ownership + accounting. The ws coordinator only
 * talks to this interface — swapping the store means implementing its
 * methods, not editing the turn loop.
 */
export interface SessionCatalog {
  /** Observed terminal metadata at its backend-normalized assistant position. */
  recordTurnFailure?(sessionId: string, backendId: string, record: RecordedTurnFailure): void;
  attachTurnFailures?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
  /** The provider/profile a stored session is pinned to, or null. */
  getStoredProviderId(sessionId: string): string | null;
  saveRetryRequest?(sessionId: string, turnId: string, principalId: string, request: ClientChatMessage, prompt: string, failure: TurnFailure): boolean;
  clearRetryRequest?(sessionId: string): void;
  /** Required to advertise Retry for file-backed requests; reads precede reservation. */
  peekRetry?(sessionId: string): retries.RetainedRetry | null;
  reserveRetry?(sessionId: string, failedTurnId: string, requestId: string, principalId: string, expectedPrompt?: string): { receipt: ServerRetryReceipt; request?: ClientChatMessage; prompt?: string };
  refuseRetry?(sessionId: string, requestId: string, principalId: string, message: string): ServerRetryReceipt;
  retryReceipt?(sessionId: string, requestId: string, principalId: string): ServerRetryReceipt;
  attachRetryRequest?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
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
  recordMessageSource?(sessionId: string, text: string, source: MessageSource, effort?: { thinkingLevel?: ThinkingLevel; turnId: string; files?: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[] }): void;
  recordEffectiveThinkingLevel?(sessionId: string, turnId: string, level: ThinkingLevel): void;
  /** Replayed history with each user message's recorded source joined on. */
  attachMessageSources?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
  /**
   * Keep a locally answered command (`/stats`) as part of the session
   * (#582). `delivered` means the prompt carrying its context is being
   * handed over now. Returns whether it is stored. Optional like the source
   * seam: without it the exchange stays on the client that ran it.
   */
  recordLocalExchange?(sessionId: string, exchange: LocalExchange, delivered: boolean): boolean;
  /** The exchanges no prompt has carried yet, marked as carried by the one being handed over. */
  takePendingLocalExchanges?(sessionId: string): LocalExchange[];
  /** Every exchange recorded for the session, for replay. */
  loadLocalExchanges?(sessionId: string): LocalExchangeRecord[];
  /**
   * Link a handoff destination to its source and its client-minted key
   * (#61). Called once `session_info` names the destination. Returns false
   * when it could not be stored.
   */
  recordHandoff?(sessionId: string, handoffId: string, sourceSessionId: string, sourceMessages: number | null): boolean;
  /** The destination already created for a handoff key, or null. */
  findHandoff?(handoffId: string): string | null;
  /**
   * Add a run's cost to a session's total without counting a turn: the
   * handoff preparation summary (#61) is spent on its source session but is
   * not a turn of its conversation. Unknown cost adds nothing.
   */
  addSessionCost?(sessionId: string, costUsd: number): void;
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
    recordTurnFailure(sessionId, backendId, record) {
      try { saveTurnFailure(db(), sessionId, backendId, record); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },
    attachTurnFailures(sessionId, messages) {
      try {
        const row = db().query("SELECT backend_id FROM sessions WHERE id = ?").get(sessionId) as { backend_id: string | null } | null;
        return row?.backend_id ? attachTurnFailures(db(), sessionId, row.backend_id, messages) : messages;
      } catch (err) {
        reportWriteFailure(sessionId, err);
        return messages;
      }
    },
    saveRetryRequest(sessionId, turnId, principalId, request, prompt, failure) {
      try { retries.saveRetryRequest(db(), sessionId, turnId, principalId, request, prompt, failure); return true; }
      catch (err) { reportWriteFailure(sessionId, err); return false; }
    },
    // Retry reads/consumption must fail closed: unlike accounting, an
    // unsuccessful invalidation cannot permit an obsolete prompt to run.
    clearRetryRequest(sessionId) { retries.clearRetryRequest(db(), sessionId); },
    peekRetry(sessionId) { return retries.retained(db(), sessionId); },
    reserveRetry(sessionId, turnId, requestId, principalId, expectedPrompt) { return retries.reserveRetry(db(), sessionId, turnId, requestId, principalId, expectedPrompt); },
    refuseRetry(sessionId, requestId, principalId, message) { return retries.refuseRetry(db(), sessionId, requestId, principalId, message); },
    retryReceipt(sessionId, requestId, principalId) { return retries.retryReceipt(db(), sessionId, requestId, principalId); },
    attachRetryRequest(sessionId, messages) {
      try { return retries.attachRetryRequest(db(), sessionId, messages); }
      catch (err) { reportWriteFailure(sessionId, err); return messages; }
    },
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

    recordMessageSource(sessionId, text, source, effort) {
      try {
        saveMessageSource(db(), sessionId, text, source, effort);
      } catch (err) {
        reportWriteFailure(sessionId, err);
      }
    },

    recordEffectiveThinkingLevel(sessionId, turnId, level) {
      try { saveEffectiveThinkingLevel(db(), sessionId, turnId, level); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },

    recordLocalExchange(sessionId, exchange, delivered) {
      try {
        saveLocalExchange(db(), sessionId, exchange, delivered);
        return true;
      } catch (err) {
        reportWriteFailure(sessionId, err);
        return false;
      }
    },

    takePendingLocalExchanges(sessionId) {
      try {
        return takePendingLocalExchanges(db(), sessionId);
      } catch (err) {
        // The prompt still goes out, without the figures: losing the turn
        // over them would be worse than the agent not seeing them.
        reportWriteFailure(sessionId, err);
        return [];
      }
    },

    loadLocalExchanges(sessionId) {
      try {
        return loadLocalExchanges(db(), sessionId);
      } catch (err) {
        log?.emit({
          severityText: "WARN",
          body: "local exchanges could not be joined onto history",
          attributes: {
            "session.id": sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        return [];
      }
    },

    recordHandoff(sessionId, handoffId, sourceSessionId, sourceMessages) {
      try {
        db()
          .prepare("UPDATE sessions SET handoff_from = ?, handoff_id = ?, handoff_from_messages = ? WHERE id = ?")
          .run(sourceSessionId, handoffId, sourceMessages, sessionId);
        return true;
      } catch (err) {
        reportWriteFailure(sessionId, err);
        return false;
      }
    },

    findHandoff(handoffId) {
      const row = db()
        .query("SELECT id FROM sessions WHERE handoff_id = ?")
        .get(handoffId) as { id: string } | null;
      return row?.id ?? null;
    },

    addSessionCost(sessionId, costUsd) {
      if (!Number.isFinite(costUsd) || costUsd <= 0) return;
      try {
        db()
          .prepare("UPDATE sessions SET total_cost_usd = COALESCE(total_cost_usd, 0) + ? WHERE id = ?")
          .run(costUsd, sessionId);
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
