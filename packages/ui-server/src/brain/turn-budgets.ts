/** Completed-inference accounting. Activity terminal rows and live receipts never add twice. */
import type { Database } from "bun:sqlite";
import type { TurnUsage, PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { priceUsage, type RollupPricing } from "../activity/store.js";
import { priceProviderAttempt } from "../pricing/provider-pricing.js";
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import type { BudgetObservation, TurnBudgetReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
export class BudgetUnavailable extends Error {
  constructor() { super("Inference budget accounting became unavailable. The turn stopped; review any partial work before continuing."); }
}
export class BudgetExceeded extends Error {
  constructor(readonly observation: BudgetObservation, readonly stage: "admission" | "mid_turn" | "sdk_backstop") {
    const amount = stage === "sdk_backstop" ? `Claude's SDK reached the $${observation.blockUsd} turn backstop; completed-response price remains ${observation.costUsd === null ? "unknown" : `at least $${observation.costUsd}`}.`
      : observation.costUsd !== null && observation.costUsd >= observation.blockUsd
        ? `At least $${observation.costUsd} list-price inference usage; stop $${observation.blockUsd}.`
        : `${observation.tokens ?? "Unknown"} observed tokens while usage is unpriced; stop ${observation.blockTokens} tokens.`;
    super(`${observation.scope === "day" ? "UTC day" : observation.scope === "session" ? "Conversation" : "Turn"} inference budget reached. ${amount} ${observation.scope === "session" ? "Review the partial work and start a new conversation to continue; the day balance still applies." : observation.scope === "day" ? `Review the partial work. The day resets at ${new Date(observation.resetAt!).toISOString()}.` : "Review the partial work before continuing."}`);
  }
}
const DAY = 86400000;
export const utcBudgetDay = (now: number) => Math.floor(now / DAY) * DAY;
type Row = {
  legacy?: boolean;
  pricing_estimate: number | null;
  turn_id: string;
  session_id: string | null;
  started_at: number;
  cost_usd: number | null;
  cost_lower_bound: number | null;
  tokens: number | null;
};
const tokensOf = (usage: TurnUsage): number | null => {
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens];
  if (!values.some(value => value !== undefined))
    return null;
  if (values.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)))
    throw new Error("Invalid completed inference receipt");
  const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  if (!Number.isSafeInteger(sum))
    throw new Error("Completed inference token total overflow");
  return sum;
};
/** What a budget receipt covers: the agent's own inference and the CLI's relayed providers (#1673). */
export const TURN_BUDGET_COVERAGE = "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered" as const;
interface ProviderTotals { attempts: number; cost: number; priced: number; tokens: number; measured: number; unpriced_measured: number }
const NO_PROVIDER_ATTEMPTS: ProviderTotals = { attempts: 0, cost: 0, priced: 0, tokens: 0, measured: 0, unpriced_measured: 0 };
/** One scope's totals against its limits. Unknown is never zero, and never blocks by itself. */
function observation(scope: BudgetObservation["scope"], selected: Row[], provider: ProviderTotals, policy: EffectiveGovernancePolicy, day: number): BudgetObservation {
  const limits = policy.budgets[scope];
  const knownCosts = selected.filter(row => row.cost_lower_bound !== null), knownTokens = selected.filter(row => row.tokens !== null);
  const total = selected.length + provider.attempts;
  const costUsd = total && !knownCosts.length && !provider.priced ? null : knownCosts.reduce((sum, row) => sum + row.cost_lower_bound!, 0) + provider.cost;
  const tokens = total && !knownTokens.length && !provider.measured ? null : knownTokens.reduce((sum, row) => sum + row.tokens!, 0) + provider.tokens;
  const unknownRuns = selected.filter(row => row.cost_usd === null).length + provider.attempts - provider.priced;
  const unpricedMeasured = selected.some(row => row.cost_usd === null && row.tokens !== null) || provider.unpriced_measured > 0;
  return { scope, legacyRuns: selected.filter(row => row.legacy).length, costUsd, tokens, unknownRuns, warnUsd: limits.warn_usd, blockUsd: limits.block_usd,
    blockTokens: limits.block_tokens, ...(limits.warn_tokens !== undefined ? { warnTokens: limits.warn_tokens } : {}),
    ...(scope === "day" ? { resetAt: day + DAY } : {}),
    warning: costUsd !== null && costUsd >= limits.warn_usd || unpricedMeasured && limits.warn_tokens !== undefined && tokens !== null && tokens >= limits.warn_tokens,
    blocked: costUsd !== null && costUsd >= limits.block_usd || unpricedMeasured && tokens !== null && tokens >= limits.block_tokens };
}
/** The usage one completed-response report measured, priced where it was reported (#2850). */
export interface MeasuredUsage { tokens: number | null; cost: number | null; estimate: number | null; partialCost: number | null }
/** One relayed attempt as priced where it was reported. */
export interface PricedAttempt { costUsd: number | null; estimate: boolean | null; tokens: number | null }
export type BudgetObservationResult = { receipt: TurnBudgetReceipt; warnings: BudgetObservation[]; blocked: BudgetObservation | undefined };

/**
 * The ledger's reads and transaction bodies, on whichever connection commits
 * them: the hosted server's write worker (`turn-budget-writes.ts`) or, without
 * one, the caller's own. `policy` is the turn's frozen admission fact and
 * `now` is taken where the call was made.
 */
export function budgetLedger(db: Database) {
  const retained = (id: string, sessionId: string | null, day: number): Row[] => db.query(`SELECT 1 AS legacy, pricing_estimate, run_id AS turn_id, session_id, started_at, cost_usd, cost_usd AS cost_lower_bound,
  CASE WHEN input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_creation_tokens IS NULL THEN NULL
    ELSE COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0) END AS tokens
  FROM activity_run_rollups WHERE origin = 'session' AND name = 'invoke_agent'
    AND (run_id=? OR session_id=? OR (started_at>=? AND started_at<?) OR run_id IN (SELECT turn_id FROM turn_budget_days WHERE day_start=?))`).all(id, sessionId, day, day + DAY, day) as Row[];
  const rows = (id: string, sessionId: string | null, day: number): Row[] => {
    const merged = new Map(retained(id, sessionId, day).map(row => [row.turn_id, row]));
    for (const live of db.query("SELECT * FROM turn_budget_usage WHERE turn_id=? OR session_id=? OR (started_at>=? AND started_at<?) OR turn_id IN (SELECT turn_id FROM turn_budget_days WHERE day_start=?)").all(id, sessionId, day, day + DAY, day) as Row[]) {
      const terminal = merged.get(live.turn_id);
      // Completed-message receipts are per-turn. Resumed SDK terminal totals can include history, so they never override a measured turn. Legacy Activity rows remain the historical source.
      merged.set(live.turn_id, { ...live, legacy: false, session_id: terminal?.session_id ?? live.session_id,
        cost_usd: live.cost_usd, cost_lower_bound: live.cost_lower_bound, tokens: live.tokens });
    }
    return [...merged.values()];
  };
  /** A day scope's rows: completed responses on their observation day, legacy residuals on their start day. */
  const daySelection = (all: Row[], day: number): Row[] => {
    const dayRows = new Map((db.query("SELECT turn_id, cost_usd, cost_lower_bound, tokens FROM turn_budget_days WHERE day_start = ?").all(day) as Array<{
      turn_id: string;
      cost_usd: number | null;
      cost_lower_bound: number | null;
      tokens: number | null;
    }>).map(row => [row.turn_id, row]));
    return all.filter(row => row.started_at >= day && row.started_at < day + DAY || dayRows.has(row.turn_id)).map(row => {
      const slice = dayRows.get(row.turn_id);
      if (!slice)
        return row;
      // Completed responses use their observation's UTC day. Legacy/final residuals retain Activity's start-day attribution.
      const slices = db.query("SELECT SUM(cost_lower_bound) AS cost, SUM(tokens) AS tokens FROM turn_budget_days WHERE turn_id = ?").get(row.turn_id) as {
        cost: number | null;
        tokens: number | null;
      };
      return { ...row, cost_lower_bound: slice.cost_lower_bound === null ? null : slice.cost_lower_bound + (utcBudgetDay(row.started_at) === day ? Math.max(0, (row.cost_lower_bound ?? 0) - (slices.cost ?? 0)) : 0),
        tokens: slice.tokens === null ? null : slice.tokens + (utcBudgetDay(row.started_at) === day ? Math.max(0, (row.tokens ?? 0) - (slices.tokens ?? 0)) : 0) };
    });
  };
  /** Relayed provider attempts in one scope (#1673): known prices, reported tokens and unknown spend. */
  const providerTotals = (where: string, value: string | number): ProviderTotals => db.query(`SELECT COUNT(*) AS attempts,
    COALESCE(SUM(cost_usd), 0) AS cost, COUNT(cost_usd) AS priced, COALESCE(SUM(tokens), 0) AS tokens, COUNT(tokens) AS measured,
    COALESCE(SUM(CASE WHEN cost_usd IS NULL AND tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS unpriced_measured
    FROM provider_relay_usage WHERE ${where}`).get(value) as ProviderTotals;
  const saved = (id: string): TurnBudgetReceipt => {
    const row = db.query("SELECT receipt FROM turn_budget_usage WHERE turn_id = ?").get(id) as { receipt: string | null } | null;
    if (!row?.receipt)
      throw new Error("Turn has no frozen budget admission");
    return JSON.parse(row.receipt) as TurnBudgetReceipt;
  };
  /** An active turn's receipt under its frozen policy, as of `now`. */
  const receipt = (id: string, policy: EffectiveGovernancePolicy, now: number): TurnBudgetReceipt => {
    const day = utcBudgetDay(now);
    const ownRow = db.query("SELECT session_id FROM turn_budget_usage WHERE turn_id=?").get(id) as {
      session_id: string | null;
    };
    const all = rows(id, ownRow.session_id, day), own = all.find(row => row.turn_id === id)!;
    const scopes = (["turn", "session", "day"] as const).map(scope => {
      const selected = scope === "turn" ? [own] : scope === "session" ? all.filter(row => own.session_id !== null && row.session_id === own.session_id) : daySelection(all, day);
      const provider = scope === "turn" ? providerTotals("turn_id = ?", id)
        : scope === "session" ? own.session_id === null ? NO_PROVIDER_ATTEMPTS : providerTotals("turn_id IN (SELECT turn_id FROM turn_budget_usage WHERE session_id = ?)", own.session_id)
        : providerTotals("day_start = ?", day);
      return observation(scope, selected, provider, policy, day);
    });
    return { listPriceCostUsd: own.cost_usd, listPriceIsEstimate: own.pricing_estimate === null ? null : Boolean(own.pricing_estimate), tokens: own.tokens, observedAt: now,
      coverage: TURN_BUDGET_COVERAGE, scopes };
  };
  /** The day scope alone, for a relayed maintenance run that belongs to no turn. */
  const dayObservation = (policy: EffectiveGovernancePolicy, now: number): BudgetObservation => {
    const day = utcBudgetDay(now);
    const selected = daySelection(rows("", null, day), day);
    return observation("day", selected, providerTotals("day_start = ?", day), policy, day);
  };
  const warningCrossings = (id: string, result: TurnBudgetReceipt) => {
    const row = db.query("SELECT session_id FROM turn_budget_usage WHERE turn_id=?").get(id) as {
      session_id: string | null;
    };
    return result.scopes.filter(item => item.warning && (item.scope !== "session" || row.session_id !== null)).filter(item => {
      const identity = item.scope === "turn" ? id : item.scope === "session" ? row.session_id! : String(utcBudgetDay(result.observedAt));
      const unit = item.costUsd !== null && item.costUsd >= item.warnUsd ? "usd" : "tokens";
      const threshold = unit === "usd" ? item.warnUsd : item.warnTokens!;
      return db.query("INSERT OR IGNORE INTO turn_budget_warnings(scope,identity,unit,threshold) VALUES(?,?,?,?)").run(item.scope, identity, unit, threshold).changes > 0;
    });
  };
  return {
    receipt, saved, dayObservation,
    begin(id: string, sessionId: string | null, policy: EffectiveGovernancePolicy, now: number): TurnBudgetReceipt {
      return db.transaction(() => {
        db.query("INSERT INTO turn_budget_usage (turn_id,session_id,started_at,cost_usd,tokens,observed_at) VALUES (?,?,?,NULL,NULL,?) ON CONFLICT(turn_id) DO NOTHING").run(id, sessionId, now, now);
        const result = receipt(id, policy, now);
        db.query("UPDATE turn_budget_usage SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(result), id);
        return result;
      }).immediate();
    },
    bind(id: string, sessionId: string): void { db.query("UPDATE turn_budget_usage SET session_id = ? WHERE turn_id = ?").run(sessionId, id); },
    observe(id: string, policy: EffectiveGovernancePolicy, measured: MeasuredUsage, now: number): BudgetObservationResult {
      return db.transaction(() => {
        const previous = db.query("SELECT * FROM turn_budget_usage WHERE turn_id = ?").get(id) as Row;
        const { tokens, cost, partialCost } = measured;
        const lower = cost ?? (partialCost === null ? previous.cost_lower_bound : Math.max(partialCost, previous.cost_lower_bound ?? 0));
        if (tokens !== null && previous.tokens !== null && tokens < previous.tokens)
          throw new Error("Completed inference receipts must be cumulative");
        const day = utcBudgetDay(now);
        const deltaCost = lower === null ? null : Math.max(0, lower - (previous.cost_lower_bound ?? 0));
        const deltaTokens = tokens === null ? null : tokens - (previous.tokens ?? 0);
        db.query("INSERT INTO turn_budget_days(turn_id,day_start,cost_usd,cost_lower_bound,tokens) VALUES(?,?,?,?,?) ON CONFLICT(turn_id,day_start) DO UPDATE SET cost_usd = CASE WHEN turn_budget_days.cost_usd IS NULL OR excluded.cost_usd IS NULL THEN NULL ELSE turn_budget_days.cost_usd+excluded.cost_usd END, cost_lower_bound = CASE WHEN turn_budget_days.cost_lower_bound IS NULL AND excluded.cost_lower_bound IS NULL THEN NULL ELSE COALESCE(turn_budget_days.cost_lower_bound,0)+COALESCE(excluded.cost_lower_bound,0) END, tokens = CASE WHEN turn_budget_days.tokens IS NULL OR excluded.tokens IS NULL THEN NULL ELSE turn_budget_days.tokens+excluded.tokens END").run(id, day, cost === null ? null : deltaCost, deltaCost, deltaTokens);
        db.query("UPDATE turn_budget_usage SET cost_usd=?,cost_lower_bound=?,pricing_estimate=?,tokens=?,observed_at=? WHERE turn_id=?").run(cost, lower, measured.estimate, tokens, now, id);
        const result = receipt(id, policy, now);
        db.query("UPDATE turn_budget_usage SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(result), id);
        const warnings = warningCrossings(id, result);
        return { receipt: result, warnings, blocked: result.scopes.find(item => item.blocked) };
      }).immediate();
    },
    warnings(id: string, policy: EffectiveGovernancePolicy, now: number) { return db.transaction(() => warningCrossings(id, receipt(id, policy, now))).immediate(); },
    backstop(id: string, policy: EffectiveGovernancePolicy, now: number): TurnBudgetReceipt {
      const result = receipt(id, policy, now);
      result.scopes[0] = { ...result.scopes[0]!, blocked: true };
      db.query("UPDATE turn_budget_usage SET receipt=? WHERE turn_id=?").run(JSON.stringify(result), id);
      return result;
    },
    /** `policy` is the active turn's, or null for a run that belongs to no active turn. */
    observeProvider(turnId: string | null, policy: EffectiveGovernancePolicy | null, attempt: ProviderRelayReceipt, priced: PricedAttempt, now: number): BudgetObservationResult | undefined {
      return db.transaction(() => {
        const inserted = db.query(`INSERT INTO provider_relay_usage (attempt_id, turn_id, day_start, observed_at, family, operation, origin, model,
          outcome, status, usage, cost_usd, pricing_estimate, tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(attempt_id) DO UPDATE SET day_start=excluded.day_start, observed_at=excluded.observed_at, outcome=excluded.outcome, status=excluded.status, usage=excluded.usage,
            cost_usd=excluded.cost_usd, pricing_estimate=excluded.pricing_estimate, tokens=excluded.tokens
          WHERE provider_relay_usage.outcome = 'dispatched' AND excluded.outcome <> 'dispatched'`).run(attempt.attemptId, turnId, utcBudgetDay(now), now,
          attempt.family, attempt.operation, attempt.origin, attempt.model, attempt.outcome, attempt.status,
          attempt.usage ? JSON.stringify(attempt.usage) : null, priced.costUsd, priced.estimate === null ? null : Number(priced.estimate), priced.tokens).changes > 0;
        if (!policy || !inserted) return undefined;
        const result = receipt(turnId!, policy, now);
        db.query("UPDATE turn_budget_usage SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(result), turnId);
        return { receipt: result, warnings: warningCrossings(turnId!, result), blocked: result.scopes.find(item => item.blocked) };
      }).immediate();
    },
  };
}

/** The write worker imports this module and runs the ledger's writes there (#2850). */
export const url = import.meta.url;
export function setup(db: Database): WriteProcedures {
  const ledger = budgetLedger(db);
  return { begin: ledger.begin, bind: ledger.bind, observe: ledger.observe, warnings: ledger.warnings, backstop: ledger.backstop, observeProvider: ledger.observeProvider };
}

/**
 * Concrete host service; policy is the already frozen admission fact, never
 * reparsed here. With a write worker every ledger write commits there, in
 * submission order (#2850); reads stay on `db`. Usage is priced where it is
 * reported, so a turn's list price is known at once; its receipt, warnings
 * and any block follow its commit. Admission waits for every budget write
 * submitted before it.
 */
export function createTurnBudgets(db: Database, pricing: RollupPricing, clock: () => number = Date.now, writer?: SqliteWriter) {
  const active = new Map<string, {
    policy: EffectiveGovernancePolicy;
    route?: PricingRoute;
    pricing: RollupPricing;
    /** A write this turn depends on failed: its accounting is unavailable. */
    failed?: unknown;
  }>();
  const ledger = budgetLedger(db);
  const submit = procedureCaller(db, { url, setup }, undefined, writer);
  // The latest budget write, until it settles: admission reads after it.
  let tail: Promise<unknown> = Promise.resolve();
  const call = <T>(name: string, ...args: unknown[]): Promise<T> => {
    const done = submit<T>(name, ...args);
    tail = done.then(() => {}, () => {});
    return done;
  };
  const settled = async () => { let waiting: Promise<unknown>; do { waiting = tail; await waiting; } while (waiting !== tail); };
  const current = (id: string) => {
    const turn = active.get(id);
    if (turn?.failed !== undefined) throw turn.failed;
    return turn;
  };
  const measure = (turn: { pricing: RollupPricing; route?: PricingRoute }, usage: TurnUsage): MeasuredUsage => {
    const tokens = tokensOf(usage);
    const priced = usage.perModel && Object.keys(usage.perModel).length ? priceUsage(usage.perModel, turn.pricing, turn.route) : null;
    const knownPrices = Object.entries(usage.perModel ?? {}).filter(([, counts]) => tokensOf(counts) !== null && tokensOf(counts)! > 0).map(([model, counts]) => priceUsage({ [model]: counts }, turn.pricing, turn.route)).filter(value => value !== null);
    const partialCost = knownPrices.length ? knownPrices.reduce((sum, value) => sum + value.costUsd, 0) : null;
    return { tokens, cost: priced?.costUsd ?? null, estimate: priced ? Number(priced.estimate) : null, partialCost };
  };
  const receipt = (id: string): TurnBudgetReceipt => {
    const turn = active.get(id);
    return turn ? ledger.receipt(id, turn.policy, clock()) : ledger.saved(id);
  };
  return {
    /** Settles once the turn's admission row and receipt have committed; rejects with `BudgetExceeded` when a session or day scope is blocked. */
    async begin(id: string, sessionId: string | undefined, policy: EffectiveGovernancePolicy, route?: PricingRoute): Promise<TurnBudgetReceipt> {
      const rates = new Map<string, ReturnType<RollupPricing["resolve"]>>();
      active.set(id, { policy, route, pricing: { resolve(model, route) {
            const key = JSON.stringify([model, route]);
            if (!rates.has(key))
              rates.set(key, structuredClone(pricing.resolve(model, route)));
            return rates.get(key)!;
          } } });
      const result = await call<TurnBudgetReceipt>("begin", id, sessionId ?? null, policy, clock());
      const blocked = result.scopes.find(item => item.blocked && item.scope !== "turn");
      if (blocked)
        throw new BudgetExceeded(blocked, "admission");
      return result;
    },
    /** A failed binding makes the turn's accounting unavailable: its session scope would miss it. */
    bind(id: string, sessionId: string): Promise<void> {
      return call<void>("bind", id, sessionId).catch((error: unknown) => {
        const turn = active.get(id);
        if (turn) turn.failed ??= error;
        throw error;
      });
    },
    /**
     * One cumulative completed-response report, priced and validated now
     * (an invalid one throws); settles with the receipt, any warning crossed
     * and any block once it has committed.
     */
    observe(id: string, usage: TurnUsage): Promise<BudgetObservationResult> | undefined {
      const turn = current(id);
      if (!turn)
        return undefined;
      return call<BudgetObservationResult>("observe", id, turn.policy, measure(turn, usage), clock());
    },
    /** The list price the receipt of this report will carry, known before it commits. */
    listPrice(id: string, usage: TurnUsage): number | null {
      const turn = active.get(id);
      return turn ? measure(turn, usage).cost : null;
    },
    receipt,
    warnings(id: string): Promise<BudgetObservation[]> {
      const turn = current(id);
      if (!turn) return Promise.reject(new Error("Turn has no frozen budget admission"));
      return call<BudgetObservation[]>("warnings", id, turn.policy, clock());
    },
    backstop(id: string): Promise<TurnBudgetReceipt> {
      const turn = current(id);
      if (!turn) return Promise.reject(new Error("Turn has no frozen budget admission"));
      return call<TurnBudgetReceipt>("backstop", id, turn.policy, clock());
    },
    saved(id: string): TurnBudgetReceipt | undefined {
      // Presentation must not turn a missing accounting receipt into a failed journal observation.
      try { return ledger.saved(id); }
      catch {
        return undefined;
      }
    },
    /**
     * Before each relayed CLI provider request (#1673), once every budget
     * write submitted before it has committed. A turn's request is refused
     * once any of its scopes is blocked; a maintenance run outside any turn,
     * once its UTC day is under `policy`. Nothing is reserved.
     */
    async providerAdmission(turnId: string | null, policy: EffectiveGovernancePolicy): Promise<BudgetObservation | undefined> {
      await settled();
      if (turnId !== null && current(turnId)) return receipt(turnId).scopes.find(item => item.blocked);
      const day = ledger.dayObservation(policy, clock());
      return day.blocked ? day : undefined;
    },
    /**
     * Record one relayed attempt once, by its attempt identity, against its
     * turn (or its day alone). A `dispatched` row is unknown spend until the
     * same attempt settles; a settled attempt never changes again, so a replay
     * adds nothing. For an active turn, settles with the new receipt, any
     * warning crossed and the scope it blocked.
     */
    observeProvider(turnId: string | null, attempt: ProviderRelayReceipt): Promise<BudgetObservationResult | undefined> {
      const turn = turnId !== null ? active.get(turnId) : undefined;
      const priced = priceProviderAttempt(attempt, turn?.pricing ?? pricing);
      return call<BudgetObservationResult | undefined>("observeProvider", turnId, turn?.policy ?? null, attempt,
        { costUsd: priced.costUsd, estimate: priced.estimate, tokens: priced.tokens }, clock());
    },
    remaining(id: string) { const own = receipt(id).scopes[0]!; return Math.max(0, own.blockUsd - (own.costUsd ?? 0)); },
    /** Settles once every budget write submitted before it has committed. */
    settled,
    end(id: string) { active.delete(id); },
  };
}
export type TurnBudgets = ReturnType<typeof createTurnBudgets>;
/** Configured limits only: no observation timestamp, reset time or running usage. */
export function inferenceBudgetLimits(receipt: TurnBudgetReceipt): string {
  return `Host inference limits (list-price limits, not subscription invoices; ${receipt.coverage}): ${receipt.scopes.map(item => `${item.scope}: warn $${item.warnUsd}; stop $${item.blockUsd}; unpriced token warn ${item.warnTokens ?? "unconfigured"}; stop ${item.blockTokens}`).join(". ")}. Stops preserve partial work for review.`;
}
/** Actionable state only; a stable warning does not become a routine usage ticker. */
export function inferenceBudgetContext(receipt: TurnBudgetReceipt): string | undefined {
  const warnings = receipt.scopes.filter(item => item.warning).map(item => `${item.scope} warning threshold reached${item.scope === "day" && item.resetAt ? ` until ${new Date(item.resetAt).toISOString()}` : ""}; finish the current result within the remaining limit and preserve partial work. Warnings are visual only in voice posture; do not speak them.`);
  return warnings.length ? warnings.join("\n") : undefined;
}
