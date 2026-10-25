/**
 * Session catalog writes off the event loop (#2850). The hosted server's app
 * connection no longer commits the session row, accepted work, turn
 * boundaries, message sources, turn failures, the state room, Claude usage
 * accounting, handoff links, labels or session costs itself: they commit on
 * the `ui.db` write worker at `synchronous=FULL`, in submission order with the
 * journal's, Activity's, governance, scope and budget writes. Each procedure
 * runs the statement or transaction that ran inline before. The catalog
 * (`session-catalog.ts`) answers its own synchronous reads from what it has
 * submitted until each write settles, and `settled()` holds the readers that
 * join history onto the committed rows. Retained retries and local exchanges
 * still commit on the app connection.
 */
import type { Database } from "bun:sqlite";
import type { BillingMode, MessageSource, PricingRoute, SharedFileMeta, StateRoomObservation, ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";

import type { WriteProcedures } from "../db/write-worker.js";
import { createActivityStore, priceUsage, type ActivityStore, type RollupPricing } from "../activity/store.js";
import { workerActivity, type ActivityWriteOptions } from "../activity/store-writes.js";
import { createModelPricing } from "../pricing/model-pricing.js";
import { resolveStandalonePricingConfig } from "../config/env.js";
import { allocateClaudeTitleUsage, reconcileClaudeUsage, type ClaudeUsageEvidence, type ClaudeUsageState } from "./claude-usage-accounting.js";
import { saveMessageSource, saveEffectiveThinkingLevel } from "./message-sources.js";
import * as work from "./session-work.js";
import { saveTurnFailure, type RecordedTurnFailure } from "./turn-failures.js";

export const url = import.meta.url;

export const UPSERT_SESSION_SQL = `INSERT INTO sessions (id, title, created_at, last_active_at, total_cost_usd, num_turns, provider_id, backend_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     last_active_at = excluded.last_active_at,
     total_cost_usd = total_cost_usd + excluded.total_cost_usd,
     num_turns = num_turns + excluded.num_turns,
     provider_id = COALESCE(excluded.provider_id, provider_id),
     backend_id = COALESCE(excluded.backend_id, backend_id)`;

/** One `sessions` upsert, with its clock taken where it was submitted. */
export interface SessionRow {
  id: string; title: string; at: number; costUsd: number; turns: number; providerId: string | null; backendId: string | null;
}

export interface ClaudeUsageContext { billingMode?: BillingMode; pricingRoute?: PricingRoute; principalId?: string }

/**
 * Where Claude usage accounting writes its title and unstreamed runs.
 * `activity` crosses to the worker (the app's Activity writer identity and
 * pricing table); `local` is an inline writer's own store and pricing.
 */
export interface SessionCatalogWriteOptions {
  activity?: ActivityWriteOptions;
  local?: () => { store: ActivityStore; pricing: RollupPricing };
}

/**
 * Claude usage reconciliation (`SessionCatalog.accountClaudeUsage`), in one
 * immediate transaction: the turn's claim, its title and unstreamed runs, the
 * session's cost and the reconciled state.
 */
export function accountClaudeUsage(db: Database, store: ActivityStore, pricing: RollupPricing, sessionId: string, backendId: string,
  turnId: string, evidence: ClaudeUsageEvidence, resumed: boolean, context?: ClaudeUsageContext): void {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM claude_usage_turns WHERE turn_id=?").get(turnId)) return;
    const row = db.query("SELECT state_json FROM claude_session_usage WHERE session_id=? AND backend_id=?")
      .get(sessionId, backendId) as { state_json: string } | null;
    const previous = row ? JSON.parse(row.state_json) as ClaudeUsageState : undefined;
    const result = reconcileClaudeUsage(previous, evidence.completed, evidence.cumulative, resumed, evidence.cumulativeCompleted);
    const allocation = allocateClaudeTitleUsage(result.auxiliary, evidence.title, previous?.titleReceiptIds);
    result.state.titleReceiptIds = allocation.seenIds;
    result.state.partial ||= allocation.partial;
    for (const [index, receipt] of allocation.title.entries()) {
      const cost = receipt.costUsd ?? priceUsage(receipt.usage.perModel!, pricing, context?.pricingRoute)?.costUsd;
      const runId = `${turnId}:claude-title:${index}`, spanId = `${runId}:root`;
      store.startSpan({ runId, spanId, sessionId, principalId: context?.principalId, kind: "turn", origin: "session",
        name: "Claude session title", attrs: { "brain.backend.id": backendId } });
      store.endSpan(spanId, { outcome: "success", usage: {
        inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens,
        cacheReadTokens: receipt.usage.cacheReadTokens, cacheCreationTokens: receipt.usage.cacheCreationTokens,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      }, attrs: { "brain.usage.source": receipt.source, "brain.usage.attribution": "title_helper",
        "brain.usage.receipt_id": receipt.receiptId, "brain.usage.coverage": "observed",
        "gen_ai.usage.per_model": receipt.usage.perModel!,
        ...(context?.billingMode ? { "brain.billing_mode": context.billingMode } : {}),
        ...(context?.pricingRoute ? { "brain.pricing_route": context.pricingRoute } : {}),
      } });
      store.rollupRun(runId);
      if (cost !== undefined) db.query("UPDATE sessions SET total_cost_usd=total_cost_usd+? WHERE id=?").run(cost, sessionId);
    }
    const auxiliaryCost = allocation.unattributed?.perModel ? priceUsage(allocation.unattributed.perModel, pricing, context?.pricingRoute)?.costUsd : undefined;
    // An independent run keeps main conversation/cache metrics clean.
    // Unavailable coverage remains visible as an unpriced run; this is
    // unstreamed usage, not a claim that a model was a title helper.
    if (allocation.unattributed || result.state.partial && !previous?.partial) {
      const runId = `${turnId}:claude-unstreamed`, spanId = `${runId}:root`;
      store.startSpan({ runId, spanId, sessionId, principalId: context?.principalId, kind: "turn", origin: "session",
        name: "Unstreamed Claude usage", attrs: { "brain.backend.id": backendId } });
      store.endSpan(spanId, { outcome: "success", usage: allocation.unattributed ? {
        inputTokens: allocation.unattributed.inputTokens, outputTokens: allocation.unattributed.outputTokens,
        cacheReadTokens: allocation.unattributed.cacheReadTokens, cacheCreationTokens: allocation.unattributed.cacheCreationTokens,
        ...(auxiliaryCost !== undefined ? { costUsd: auxiliaryCost } : {}),
      } : undefined, attrs: {
        "brain.usage.source": "claude_session_cumulative_remainder",
        "brain.usage.attribution": "unattributed",
        ...(evidence.title ? { "brain.usage.title_evidence": JSON.stringify(evidence.title) } : {}),
        "brain.usage.coverage": result.state.partial ? "partial" : "observed",
        ...(allocation.unattributed?.perModel ? { "gen_ai.usage.per_model": allocation.unattributed.perModel } : {}),
        ...(allocation.unattributed && context?.billingMode ? { "brain.billing_mode": context.billingMode } : {}),
        ...(context?.pricingRoute ? { "brain.pricing_route": context.pricingRoute } : {}),
        ...(evidence.reportedCostUsd !== undefined ? { "brain.usage.reported_session_cost_usd": evidence.reportedCostUsd } : {}),
      } });
      store.rollupRun(runId);
      if (auxiliaryCost !== undefined) db.query("UPDATE sessions SET total_cost_usd=total_cost_usd+? WHERE id=?").run(auxiliaryCost, sessionId);
    }
    db.query("INSERT INTO claude_session_usage VALUES (?,?,?) ON CONFLICT(session_id,backend_id) DO UPDATE SET state_json=excluded.state_json")
      .run(sessionId, backendId, JSON.stringify(result.state));
    db.query("INSERT INTO claude_usage_turns VALUES (?,?,?)").run(turnId, sessionId, backendId);
  }).immediate();
}

/** Worker side: every procedure is one of the catalog's synchronous writers, run on the write connection. */
export function setup(db: Database, options: SessionCatalogWriteOptions = {}): WriteProcedures {
  // Built on first use, as the catalog's own accounting was.
  let accounting: { store: ActivityStore; pricing: () => RollupPricing } | undefined;
  const account = () => accounting ??= (() => {
    if (options.local) { const { store, pricing } = options.local(); return { store, pricing: () => pricing }; }
    let standalone: RollupPricing | undefined;
    const fallback = () => standalone ??= createModelPricing(resolveStandalonePricingConfig());
    if (!options.activity) { const pricing = fallback(); return { store: createActivityStore(db, { pricing }), pricing: () => pricing }; }
    const activity = workerActivity(db, options.activity);
    return { store: activity.store, pricing: activity.pricing ?? fallback };
  })();
  return {
    upsertSession(row: SessionRow) {
      db.prepare(UPSERT_SESSION_SQL).run(row.id, row.title, row.at, row.at, row.costUsd, row.turns, row.providerId, row.backendId);
    },
    claudeUsage(sessionId: string, backendId: string, turnId: string, evidence: ClaudeUsageEvidence, resumed: boolean, context?: ClaudeUsageContext) {
      const { store, pricing } = account();
      accountClaudeUsage(db, store, pricing(), sessionId, backendId, turnId, evidence, resumed, context);
    },
    stateRoom(sessionId: string, observation: StateRoomObservation) {
      db.query("INSERT INTO session_state_room (session_id, observation) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET observation = excluded.observation")
        .run(sessionId, JSON.stringify(observation));
    },
    turnFailure: (sessionId: string, backendId: string, record: RecordedTurnFailure) => saveTurnFailure(db, sessionId, backendId, record),
    acceptWork: (sessionId: string, input: { revision: number; requestId: string | null; backendId: string | null; at: number }) =>
      work.acceptWork(db, sessionId, input),
    dispatchWork: (sessionId: string, input: { revision: number; turnId: string; backendId: string; startedAt: number }) =>
      work.dispatchWork(db, sessionId, input),
    turnBoundary: (sessionId: string, backendId: string, boundary: work.TurnBoundary) => work.saveTurnBoundary(db, sessionId, backendId, boundary),
    messageSource: (sessionId: string, text: string, source: MessageSource, effort: { thinkingLevel?: ThinkingLevel; turnId: string; files?: SharedFileMeta[] } | undefined, at: number) =>
      saveMessageSource(db, sessionId, text, source, effort, at),
    effectiveThinkingLevel: (sessionId: string, turnId: string, level: ThinkingLevel) => saveEffectiveThinkingLevel(db, sessionId, turnId, level),
    // A stub that failed to persist leaves no row to update: that is not a
    // recorded link, and saying so keeps the caller's key fail-closed.
    handoff: (sessionId: string, handoffId: string, sourceSessionId: string, sourceTurns: number | null) =>
      db.query("UPDATE sessions SET handoff_from = ?, handoff_id = ?, handoff_from_turns = ? WHERE id = ? RETURNING id")
        .get(sourceSessionId, handoffId, sourceTurns, sessionId) !== null,
    label(sessionId: string, label: string, source: string) {
      db.prepare("UPDATE sessions SET label = ?, label_source = ? WHERE id = ?").run(label, source, sessionId);
    },
    addCost(sessionId: string, costUsd: number) {
      db.prepare("UPDATE sessions SET total_cost_usd = COALESCE(total_cost_usd, 0) + ? WHERE id = ?").run(costUsd, sessionId);
    },
  };
}
