import { createActivityStore, priceUsage, type ActivityStore, type RollupPricing } from "../activity/store.js";
import { createModelPricing } from "../pricing/model-pricing.js";
import { resolveStandalonePricingConfig } from "../config/env.js";
import { reconcileClaudeUsage, type ClaudeUsageEvidence, type ClaudeUsageState } from "./claude-usage-accounting.js";
import type { BillingMode, PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
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
  StateRoomObservation,
} from "@schlessera/brain-ui-sdk/protocol";
import { stateRoomObservationSchema } from "@schlessera/brain-ui-sdk/schemas";

import { attachMessageSources, saveMessageSource, saveEffectiveThinkingLevel } from "./message-sources.js";
import {
  loadLocalExchanges,
  saveLocalExchange,
  takePendingLocalExchanges,
  type LocalExchangeRecord,
} from "./local-exchanges.js";

import * as retries from "./retry-requests.js";
import * as work from "./session-work.js";
import { attachTurnFailures, saveTurnFailure, type RecordedTurnFailure } from "./turn-failures.js";
import { bindTurnEvents, recordGovernanceEvent, type GovernanceEventInput } from "../governance/events.js";

/**
 * Persistence seam for session ownership + accounting. The ws coordinator only
 * talks to this interface — swapping the store means implementing its
 * methods, not editing the turn loop.
 */
export interface SessionCatalog {
  /** Claude cumulative totals are evidence only; returns this turn's priced
   * completed responses and retains newly measured unstreamed usage once. */
  accountClaudeUsage?(sessionId: string, backendId: string, turnId: string, evidence: ClaudeUsageEvidence,
    resumed: boolean, context?: { billingMode?: BillingMode; pricingRoute?: PricingRoute; principalId?: string }): number | undefined;

  recordStateRoom?(sessionId: string, observation: StateRoomObservation): void;
  readStateRoom?(sessionId: string): StateRoomObservation | undefined;
  /** Scratch links in backend-persisted answers, before next-turn pruning. */
  recordScratchPins?(sessionId: string, backendId: string, messages: SessionHistoryMessage[]): void;
  /** Observed terminal metadata at its backend-normalized assistant position. */
  recordTurnFailure?(sessionId: string, backendId: string, record: RecordedTurnFailure): void;
  attachTurnFailures?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
  /**
   * Record an accepted request and return its revision (#964), or null when
   * it could not be stored. Never throws: acceptance must not fail a turn.
   */
  acceptWork?(sessionId: string, requestId: string | null, backendId: string | null): number | null;
  /** Record the turn that runs the request accepted at `revision`. */
  dispatchWork?(sessionId: string, revision: number, turnId: string, backendId: string, startedAt: number): void;
  /** The latest accepted request, or null. Throws when the read fails. */
  latestWork?(sessionId: string): work.AcceptedWork | null;
  /** Whether the catalog holds a row for this session. Throws when the read fails. */
  hasSession?(sessionId: string): boolean;
  /** Observed position of a finished turn's last answer (#964). */
  recordTurnBoundary?(sessionId: string, backendId: string, boundary: work.TurnBoundary): void;
  /** Replayed history with host-proven turn ids joined onto the answers that ended each turn. */
  attachTurnBoundaries?(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
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
  recordHandoff?(sessionId: string, handoffId: string, sourceSessionId: string, sourceTurns: number | null): boolean;
  /** The destination already created for a handoff key, or null. */
  findHandoff?(handoffId: string): string | null;
  /**
   * Add a run's cost to a session's total without counting a turn: the
   * handoff preparation summary (#61) is spent on its source session but is
   * not a turn of its conversation. Unknown cost adds nothing.
   */
  addSessionCost?(sessionId: string, costUsd: number): void;
  /**
   * The pill label stored for a session (#1004) and the hash of the text it
   * was written from, or null. Never throws: a failed read is no label.
   */
  sessionLabel?(sessionId: string): { label: string; source: string } | null;
  /** Store a session's pill label and its source hash; a missing row stores nothing. */
  saveSessionLabel?(sessionId: string, label: string, source: string): void;
  /**
   * Attach the turn's governance events recorded before its session had a
   * catalog row (#1651). Called once `session_info` has persisted the row.
   * Never throws.
   */
  bindGovernanceEvents?(turnId: string, sessionId: string): void;
  /**
   * Keep one governance event (#1651) with the session history. An invalid
   * event or a failed write is logged, never thrown: a record must not fail
   * the turn it describes.
   */
  recordGovernanceEvent?(event: GovernanceEventInput): void;
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
export function createSessionCatalog(db: () => Database, log?: Logger, scratchPins?: { record(sessionId: string, backendId: string, messages: SessionHistoryMessage[]): void },
  accounting?: { pricing: RollupPricing; store: ActivityStore }): SessionCatalog {
  let accountingDeps = accounting;
  const getAccounting = () => accountingDeps ??= (() => {
    const pricing = createModelPricing(resolveStandalonePricingConfig());
    return { pricing, store: createActivityStore(db(), { pricing }) };
  })();
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
    accountClaudeUsage(sessionId, backendId, turnId, evidence, resumed, context) {
      const { pricing, store } = getAccounting();
      const mainCost = evidence.completed?.perModel ? priceUsage(evidence.completed.perModel, pricing, context?.pricingRoute)?.costUsd : undefined;
      try {
        db().transaction(() => {
          if (db().query("SELECT 1 FROM claude_usage_turns WHERE turn_id=?").get(turnId)) return;
          const row = db().query("SELECT state_json FROM claude_session_usage WHERE session_id=? AND backend_id=?")
            .get(sessionId, backendId) as { state_json: string } | null;
          const previous = row ? JSON.parse(row.state_json) as ClaudeUsageState : undefined;
          const result = reconcileClaudeUsage(previous, evidence.completed, evidence.cumulative, resumed, evidence.cumulativeCompleted);
          const auxiliaryCost = result.auxiliary?.perModel ? priceUsage(result.auxiliary.perModel, pricing, context?.pricingRoute)?.costUsd : undefined;
          // An independent run keeps main conversation/cache metrics clean.
          // Unavailable coverage remains visible as an unpriced run; this is
          // unstreamed usage, not a claim that a model was a title helper.
          if (result.auxiliary || result.state.partial && !previous?.partial) {
            const runId = `${turnId}:claude-unstreamed`, spanId = `${runId}:root`;
            store.startSpan({ runId, spanId, sessionId, principalId: context?.principalId, kind: "turn", origin: "session",
              name: "Unstreamed Claude usage", attrs: { "brain.backend.id": backendId } });
            store.endSpan(spanId, { outcome: "success", usage: result.auxiliary ? {
              inputTokens: result.auxiliary.inputTokens, outputTokens: result.auxiliary.outputTokens,
              cacheReadTokens: result.auxiliary.cacheReadTokens, cacheCreationTokens: result.auxiliary.cacheCreationTokens,
              ...(auxiliaryCost !== undefined ? { costUsd: auxiliaryCost } : {}),
            } : undefined, attrs: {
              "brain.usage.source": "claude_session_cumulative_remainder",
              "brain.usage.attribution": "unattributed",
              "brain.usage.coverage": result.state.partial ? "partial" : "observed",
              ...(result.auxiliary?.perModel ? { "gen_ai.usage.per_model": result.auxiliary.perModel } : {}),
              ...(result.auxiliary && context?.billingMode ? { "brain.billing_mode": context.billingMode } : {}),
              ...(context?.pricingRoute ? { "brain.pricing_route": context.pricingRoute } : {}),
              ...(evidence.reportedCostUsd !== undefined ? { "brain.usage.reported_session_cost_usd": evidence.reportedCostUsd } : {}),
            } });
            store.rollupRun(runId);
            if (auxiliaryCost !== undefined) db().query("UPDATE sessions SET total_cost_usd=total_cost_usd+? WHERE id=?").run(auxiliaryCost, sessionId);
          }
          db().query("INSERT INTO claude_session_usage VALUES (?,?,?) ON CONFLICT(session_id,backend_id) DO UPDATE SET state_json=excluded.state_json")
            .run(sessionId, backendId, JSON.stringify(result.state));
          db().query("INSERT INTO claude_usage_turns VALUES (?,?,?)").run(turnId, sessionId, backendId);
        }).immediate();
      } catch (error) { reportWriteFailure(sessionId, error); }
      return mainCost;
    },
    recordStateRoom(sessionId, observation) {
      try {
        const parsed = stateRoomObservationSchema.parse(observation);
        db().query("INSERT INTO session_state_room (session_id, observation) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET observation = excluded.observation")
          .run(sessionId, JSON.stringify(parsed));
      } catch (error) { reportWriteFailure(sessionId, error); }
    },
    readStateRoom(sessionId) {
      try {
        const row = db().query("SELECT observation FROM session_state_room WHERE session_id = ?").get(sessionId) as { observation: string } | null;
        return row ? stateRoomObservationSchema.parse(JSON.parse(row.observation)) : undefined;
      } catch (error) { reportWriteFailure(sessionId, error); return undefined; }
    },
    recordScratchPins(sessionId, backendId, messages) {
      try { scratchPins?.record(sessionId, backendId, messages); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },
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
    acceptWork(sessionId, requestId, backendId) {
      try { return work.acceptWork(db(), sessionId, { requestId, backendId, at: Date.now() }); }
      catch (err) { reportWriteFailure(sessionId, err); return null; }
    },
    dispatchWork(sessionId, revision, turnId, backendId, startedAt) {
      try { work.dispatchWork(db(), sessionId, { revision, turnId, backendId, startedAt }); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },
    latestWork(sessionId) { return work.latestWork(db(), sessionId); },
    hasSession(sessionId) {
      return db().query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== null;
    },
    recordTurnBoundary(sessionId, backendId, boundary) {
      try { work.saveTurnBoundary(db(), sessionId, backendId, boundary); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },
    attachTurnBoundaries(sessionId, messages) {
      try {
        const row = db().query("SELECT backend_id FROM sessions WHERE id = ?").get(sessionId) as { backend_id: string | null } | null;
        return row?.backend_id ? work.attachTurnBoundaries(db(), sessionId, row.backend_id, messages) : messages;
      } catch (err) {
        // Without the boundaries a replay carries no turn ids, which is
        // what it carried before they existed: unproven, never wrong.
        reportWriteFailure(sessionId, err);
        return messages;
      }
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

    recordHandoff(sessionId, handoffId, sourceSessionId, sourceTurns) {
      try {
        // A stub that failed to persist leaves no row to update: that is not
        // a recorded link, and saying so keeps the caller's key fail-closed.
        const result = db()
          .prepare("UPDATE sessions SET handoff_from = ?, handoff_id = ?, handoff_from_turns = ? WHERE id = ?")
          .run(sourceSessionId, handoffId, sourceTurns, sessionId);
        return result.changes === 1;
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

    sessionLabel(sessionId) {
      try {
        const row = db()
          .query("SELECT label, label_source AS source FROM sessions WHERE id = ?")
          .get(sessionId) as { label: string | null; source: string | null } | null;
        return row?.label && row.source ? { label: row.label, source: row.source } : null;
      } catch {
        return null;
      }
    },

    saveSessionLabel(sessionId, label, source) {
      try {
        db()
          .prepare("UPDATE sessions SET label = ?, label_source = ? WHERE id = ?")
          .run(label, source, sessionId);
      } catch (err) {
        reportWriteFailure(sessionId, err);
      }
    },

    bindGovernanceEvents(turnId, sessionId) {
      try { bindTurnEvents(db(), turnId, sessionId); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },

    recordGovernanceEvent(event) {
      try { recordGovernanceEvent(db(), event); }
      catch (err) {
        log?.emit({
          severityText: "WARN",
          body: "governance event not recorded",
          attributes: {
            "governance.kind": String(event.kind),
            ...(event.sessionId ? { "session.id": event.sessionId } : {}),
            ...(event.turnId ? { "turn.id": event.turnId } : {}),
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
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
