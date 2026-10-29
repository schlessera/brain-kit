import { createActivityStore, priceUsage, type ActivityStore, type AwaitableActivityStore, type RollupPricing } from "../activity/store.js";
import type { ActivityPricingConfig } from "../activity/store-writes.js";
import { createModelPricing } from "../pricing/model-pricing.js";
import { resolveStandalonePricingConfig } from "../config/env.js";
import type { ClaudeUsageEvidence } from "./claude-usage-accounting.js";
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

import { attachMessageSources } from "./message-sources.js";
import {
  loadLocalExchanges,
  type LocalExchangeRecord,
} from "./local-exchanges.js";

import { loadConversation } from "./conversation-storage.js";
import * as retries from "./retry-requests.js";
import * as work from "./session-work.js";
import { attachTurnFailures, type RecordedTurnFailure } from "./turn-failures.js";
import * as writes from "./session-catalog-writes.js";
import { procedureCaller, type ProcedureCall, type SqliteWriter } from "../db/write-worker.js";
import type { GovernanceEventInput } from "../governance/events.js";
import { createGovernanceWrites, type GovernanceWrites } from "../governance/event-writes.js";

/**
 * Persistence seam for session ownership + accounting. The ws coordinator only
 * talks to this interface — swapping the store means implementing its
 * methods, not editing the turn loop.
 */
export interface SessionCatalog {
  /** Host identity persistence, never an executable replay queue. */
  saveConversationEpoch?(state: import("./conversation-storage.js").StoredConversationEpoch): Promise<void>;
  saveConversationTask?(principalId: string, receipt: import("@schlessera/brain-ui-sdk/protocol").ConversationWorkReceipt, facts?: string): Promise<void>;
  loadConversation?(id: string, principalId: string): Promise<import("./conversation-storage.js").StoredConversation | null>;
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
   * Settles once every catalog write submitted before it has settled
   * (#2850): a reader that joins committed rows onto history awaits it.
   */
  settled?(): Promise<void>;
  /**
   * Record an accepted request and return its revision (#964), or null when
   * none could be assigned. `settled` hears whether it was stored. Never
   * throws: acceptance must not fail a turn.
   */
  acceptWork?(sessionId: string, requestId: string | null, backendId: string | null, settled?: (stored: boolean) => void): number | null;
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
  reserveRetry?(sessionId: string, failedTurnId: string, requestId: string, principalId: string, expectedPrompt?: string): Promise<{ receipt: ServerRetryReceipt; request?: ClientChatMessage; prompt?: string }>;
  refuseRetry?(sessionId: string, requestId: string, principalId: string, message: string): Promise<ServerRetryReceipt>;
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
  recordLocalExchange?(sessionId: string, exchange: LocalExchange, delivered: boolean): Promise<boolean>;
  /** The exchanges no prompt has carried yet, marked as carried by the one being handed over. */
  takePendingLocalExchanges?(sessionId: string): LocalExchange[];
  /** Every exchange recorded for the session, for replay. */
  loadLocalExchanges?(sessionId: string): LocalExchangeRecord[];
  /**
   * Link a handoff destination to its source and its client-minted key
   * (#61). Called once `session_info` names the destination. Settles false
   * when it could not be stored.
   */
  recordHandoff?(sessionId: string, handoffId: string, sourceSessionId: string, sourceTurns: number | null): Promise<boolean>;
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

/** SQLite-backed catalog over the app's own database (injected by createApp). */
export function createSessionCatalog(db: () => Database, log?: Logger, scratchPins?: { record(sessionId: string, backendId: string, messages: SessionHistoryMessage[]): void },
  accounting?: { pricing: RollupPricing; store: AwaitableActivityStore; governance?: Pick<GovernanceWrites, "record" | "bind">;
    /** Where catalog rows commit: the app's write worker (#2850). Absent, they commit on `db` at once. */
    writer?: SqliteWriter; pricingConfig?: ActivityPricingConfig }): SessionCatalog {
  let accountingDeps = accounting;
  // Governance rows commit on the write worker when the app has one (#2850).
  let governanceWrites = accounting?.governance;
  const governance = () => governanceWrites ??= createGovernanceWrites(db());
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

  // Every catalog write is one procedure call, committed in submission order
  // (#2850). `tail` is the latest one's settlement: the worker settles calls
  // in order, so once it has settled, so has every write submitted before it.
  let caller: ProcedureCall | undefined;
  let tail: Promise<void> = Promise.resolve();
  const settle = (done: Promise<unknown>) => { tail = done.then(() => {}, () => {}); };
  const submit = <T>(name: string, ...args: unknown[]): Promise<T> => {
    let done: Promise<T>;
    try {
      caller ??= procedureCaller(db(), { url: writes.url, setup: writes.setup }, accounting?.writer
        ? { activity: { writer: accounting.store.writer, ...(accounting.pricingConfig ? { pricing: accounting.pricingConfig } : {}) } }
        : { local: () => ({ store: getAccounting().store as ActivityStore, pricing: getAccounting().pricing }) }, accounting?.writer);
      done = caller<T>(name, ...args);
    } catch (error) { done = Promise.reject(error); }
    settle(done);
    return done;
  };

  // The effects of writes submitted and not yet settled, per session, in
  // submission order. A synchronous read on the turn path answers from the
  // committed row with these applied, so a write is visible from its
  // submission, as it was when it committed inline. Each effect goes when its
  // own write settles: a failed one stops counting at once.
  type RowEffect = { upsert: { providerId: string | null; backendId: string | null } } | { label: { label: string; source: string } };
  const rowEffects = new Map<string, RowEffect[]>();
  const pendingExchanges = new Map<string, LocalExchange[]>();
  const takenExchanges = new Map<string, Set<string>>();
  const pendingWork = new Map<string, Array<(row: work.AcceptedWork | null) => work.AcceptedWork | null>>();
  const track = <E, T>(effects: Map<string, E[]>, sessionId: string, effect: E, done: Promise<T>): Promise<T> => {
    const list = effects.get(sessionId) ?? [];
    list.push(effect);
    effects.set(sessionId, list);
    void done.then(() => {}, () => {}).then(() => {
      list.splice(list.indexOf(effect), 1);
      if (list.length === 0 && effects.get(sessionId) === list) effects.delete(sessionId);
    });
    return done;
  };
  const committedRow = (sessionId: string) => db()
    .query("SELECT provider_id AS providerId, backend_id AS backendId FROM sessions WHERE id = ?")
    .get(sessionId) as { providerId: string | null; backendId: string | null } | null;
  /** The latest non-null value a pending upsert gives (its COALESCE), else none. */
  const pendingValue = (sessionId: string, key: "providerId" | "backendId"): string | null => {
    const effects = rowEffects.get(sessionId) ?? [];
    for (let index = effects.length - 1; index >= 0; index--) {
      const effect = effects[index]!;
      if ("upsert" in effect && effect.upsert[key] !== null) return effect.upsert[key];
    }
    return null;
  };
  const pendingRow = (sessionId: string) => (rowEffects.get(sessionId) ?? []).some(effect => "upsert" in effect);
  const storedBackendId = (sessionId: string) => pendingValue(sessionId, "backendId") ?? committedRow(sessionId)?.backendId ?? null;
  const hasRow = (sessionId: string) => pendingRow(sessionId) || db().query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== null;
  const upsert = (sessionId: string, promptText: string, providerId: string | null, backendId: string, costUsd: number, turns: number) => {
    const row: writes.SessionRow = { id: sessionId, title: promptText.slice(0, 100), at: Date.now(), costUsd, turns, providerId, backendId };
    return track(rowEffects, sessionId, { upsert: { providerId, backendId } }, submit<void>("upsertSession", row));
  };
  /** Highest revision issued per session; it never goes down, so a failed acceptance's revision is never reused. */
  const issued = new Map<string, number>();
  const latestWork = (sessionId: string): work.AcceptedWork | null => {
    let row = work.latestWork(db(), sessionId);
    for (const effect of pendingWork.get(sessionId) ?? []) row = effect(row);
    return row;
  };
  // Invalidation counts at submission, even if its worker DELETE fails.
  // Only a new successfully retained request in this generation can reset it.
  const retryGenerations = new Map<string, number>();
  const invalidatedRetries = new Set<string>();
  return {
    saveConversationEpoch: state => submit("conversationEpoch", state),
    saveConversationTask: (principalId, receipt, facts) => submit("conversationTask", principalId, receipt, facts),
    async loadConversation(id, principalId) { await tail; return loadConversation(db(), id, principalId); },
    async settled() { let waiting: Promise<void>; do { waiting = tail; await waiting; } while (waiting !== tail); },
    accountClaudeUsage(sessionId, backendId, turnId, evidence, resumed, context) {
      let mainCost: number | undefined;
      try {
        const { pricing } = getAccounting();
        mainCost = evidence.completed?.perModel ? priceUsage(evidence.completed.perModel, pricing, context?.pricingRoute)?.costUsd : undefined;
        submit("claudeUsage", sessionId, backendId, turnId, evidence, resumed, context).catch(error => reportWriteFailure(sessionId, error));
      } catch (error) { reportWriteFailure(sessionId, error); }
      return mainCost;
    },
    recordStateRoom(sessionId, observation) {
      try {
        const parsed = stateRoomObservationSchema.parse(observation);
        submit("stateRoom", sessionId, parsed).catch(error => reportWriteFailure(sessionId, error));
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
      submit("turnFailure", sessionId, backendId, record).catch(err => reportWriteFailure(sessionId, err));
    },
    attachTurnFailures(sessionId, messages) {
      try {
        const backendId = storedBackendId(sessionId);
        return backendId ? attachTurnFailures(db(), sessionId, backendId, messages) : messages;
      } catch (err) {
        reportWriteFailure(sessionId, err);
        return messages;
      }
    },
    saveRetryRequest(sessionId, turnId, principalId, request, prompt, failure) {
      const generation = retryGenerations.get(sessionId) ?? 0;
      const save = () => submit<void>("saveRetryRequest", sessionId, turnId, principalId, request, prompt, failure).then(() => {
        if ((retryGenerations.get(sessionId) ?? 0) === generation) invalidatedRetries.delete(sessionId);
      });
      // Keep the pending session row ahead of its retry, and do not retain a
      // deferred failure if an accepted input invalidated it meanwhile.
      const stored = pendingRow(sessionId)
        ? tail.then(() => { if ((retryGenerations.get(sessionId) ?? 0) === generation) return save(); })
        : save();
      settle(stored);
      stored.catch(err => reportWriteFailure(sessionId, err));
      return true;
    },
    clearRetryRequest(sessionId) {
      retryGenerations.set(sessionId, (retryGenerations.get(sessionId) ?? 0) + 1);
      invalidatedRetries.add(sessionId);
      submit("clearRetryRequest", sessionId).catch(err => reportWriteFailure(sessionId, err));
    },
    peekRetry(sessionId) { return invalidatedRetries.has(sessionId) ? null : retries.retained(db(), sessionId); },
    reserveRetry(sessionId, turnId, requestId, principalId, expectedPrompt) {
      return submit("reserveRetry", sessionId, turnId, requestId, principalId, expectedPrompt);
    },
    refuseRetry(sessionId, requestId, principalId, message) { return submit("refuseRetry", sessionId, requestId, principalId, message); },
    retryReceipt(sessionId, requestId, principalId) { return retries.retryReceipt(db(), sessionId, requestId, principalId); },
    attachRetryRequest(sessionId, messages) {
      try { return invalidatedRetries.has(sessionId) ? messages : retries.attachRetryRequest(db(), sessionId, messages); }
      catch (err) { reportWriteFailure(sessionId, err); return messages; }
    },
    acceptWork(sessionId, requestId, backendId, settled) {
      let revision: number;
      let latest: work.AcceptedWork | null;
      const at = Date.now();
      try {
        latest = latestWork(sessionId);
        revision = Math.max(issued.get(sessionId) ?? 0, latest?.revision ?? 0) + 1;
      } catch (err) { reportWriteFailure(sessionId, err); return null; }
      issued.set(sessionId, revision);
      // The statement's own effect: the upsert keeps the stored backend when none is given.
      track(pendingWork, sessionId, (row: work.AcceptedWork | null) => (
        { revision, requestId, turnId: null, backendId: backendId ?? row?.backendId ?? null, acceptedAt: at, startedAt: null }),
      submit("acceptWork", sessionId, { revision, requestId, backendId, at }))
        .then(() => settled?.(true), err => { reportWriteFailure(sessionId, err); settled?.(false); });
      return revision;
    },
    dispatchWork(sessionId, revision, turnId, backendId, startedAt) {
      // The statement's own effect: only the latest acceptance, not yet dispatched, takes the turn.
      track(pendingWork, sessionId, (row: work.AcceptedWork | null) => row && row.revision === revision && row.turnId === null
        ? { ...row, turnId, startedAt, backendId: row.backendId ?? backendId } : row,
      submit("dispatchWork", sessionId, { revision, turnId, backendId, startedAt })).catch(err => reportWriteFailure(sessionId, err));
    },
    latestWork,
    hasSession: hasRow,
    recordTurnBoundary(sessionId, backendId, boundary) {
      submit("turnBoundary", sessionId, backendId, boundary).catch(err => reportWriteFailure(sessionId, err));
    },
    attachTurnBoundaries(sessionId, messages) {
      try {
        const backendId = storedBackendId(sessionId);
        return backendId ? work.attachTurnBoundaries(db(), sessionId, backendId, messages) : messages;
      } catch (err) {
        // Without the boundaries a replay carries no turn ids, which is
        // what it carried before they existed: unproven, never wrong.
        reportWriteFailure(sessionId, err);
        return messages;
      }
    },
    getStoredProviderId(sessionId) {
      return pendingValue(sessionId, "providerId") ?? committedRow(sessionId)?.providerId ?? null;
    },

    getStoredBackendId: storedBackendId,

    persistSessionStub(sessionId, promptText, providerId, backendId) {
      upsert(sessionId, promptText, providerId, backendId, 0, 0).catch(err => reportWriteFailure(sessionId, err));
    },

    persistSession(msg, promptText, providerId, backendId) {
      // costUsd is optional (rev 2): absent = unknown, accounted as 0.
      upsert(msg.sessionId, promptText, providerId, backendId, msg.costUsd ?? 0, msg.numTurns).catch(err => reportWriteFailure(msg.sessionId, err));
    },

    recordMessageSource(sessionId, text, source, effort) {
      // Its clock is taken now; its ordinal where it commits, in order.
      submit("messageSource", sessionId, text, source, effort, Date.now()).catch(err => reportWriteFailure(sessionId, err));
    },

    recordEffectiveThinkingLevel(sessionId, turnId, level) {
      submit("effectiveThinkingLevel", sessionId, turnId, level).catch(err => reportWriteFailure(sessionId, err));
    },

    // Settles once stored (#2850). Until then a pending exchange is still
    // taken by the next prompt handed over, as when it committed inline.
    recordLocalExchange(sessionId, exchange, delivered) {
      const done = submit<void>("localExchange", sessionId, exchange, delivered, Date.now());
      if (!delivered) track(pendingExchanges, sessionId, exchange, done);
      return done.then(() => true, (err: unknown) => { reportWriteFailure(sessionId, err); return false; });
    },

    // Taken where the prompt is handed over, at once: the committed pending
    // exchanges and those still committing, less any another prompt has
    // already taken. Exactly these are then marked carried, after their
    // records, on the write worker.
    takePendingLocalExchanges(sessionId) {
      try {
        const claimed = takenExchanges.get(sessionId) ?? new Set<string>();
        const seen = new Set<string>();
        const taken: LocalExchange[] = [];
        for (const record of loadLocalExchanges(db(), sessionId)) {
          if (record.delivered || claimed.has(record.id) || seen.has(record.id)) continue;
          seen.add(record.id);
          const { seq: _seq, delivered: _delivered, ...exchange } = record;
          taken.push(exchange);
        }
        for (const exchange of pendingExchanges.get(sessionId) ?? []) {
          if (claimed.has(exchange.id) || seen.has(exchange.id)) continue;
          seen.add(exchange.id);
          taken.push(exchange);
        }
        if (!taken.length) return [];
        const ids = taken.map(exchange => exchange.id);
        for (const id of ids) claimed.add(id);
        takenExchanges.set(sessionId, claimed);
        void submit("exchangesDelivered", sessionId, ids, Date.now()).catch(err => reportWriteFailure(sessionId, err)).finally(() => {
          for (const id of ids) claimed.delete(id);
          if (!claimed.size && takenExchanges.get(sessionId) === claimed) takenExchanges.delete(sessionId);
        });
        return taken;
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
      return submit<boolean>("handoff", sessionId, handoffId, sourceSessionId, sourceTurns)
        .catch((err: unknown) => { reportWriteFailure(sessionId, err); return false; });
    },

    findHandoff(handoffId) {
      const row = db()
        .query("SELECT id FROM sessions WHERE handoff_id = ?")
        .get(handoffId) as { id: string } | null;
      return row?.id ?? null;
    },

    sessionLabel(sessionId) {
      try {
        // A label lands only on a row that exists by the time it commits.
        const pending = [...rowEffects.get(sessionId) ?? []].reverse().find(effect => "label" in effect);
        if (pending && "label" in pending && hasRow(sessionId)) return pending.label;
        const row = db()
          .query("SELECT label, label_source AS source FROM sessions WHERE id = ?")
          .get(sessionId) as { label: string | null; source: string | null } | null;
        return row?.label && row.source ? { label: row.label, source: row.source } : null;
      } catch {
        return null;
      }
    },

    saveSessionLabel(sessionId, label, source) {
      track(rowEffects, sessionId, { label: { label, source } }, submit("label", sessionId, label, source))
        .catch(err => reportWriteFailure(sessionId, err));
    },

    bindGovernanceEvents(turnId, sessionId) {
      try { governance().bind(turnId, sessionId).catch((err: unknown) => reportWriteFailure(sessionId, err)); }
      catch (err) { reportWriteFailure(sessionId, err); }
    },

    recordGovernanceEvent(event) {
      const notRecorded = (err: unknown) => {
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
      };
      try { governance().record(event).catch(notRecorded); }
      catch (err) { notRecorded(err); }
    },

    addSessionCost(sessionId, costUsd) {
      if (!Number.isFinite(costUsd) || costUsd <= 0) return;
      submit("addCost", sessionId, costUsd).catch(err => reportWriteFailure(sessionId, err));
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
