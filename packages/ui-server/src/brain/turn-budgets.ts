/** Completed-inference accounting. Activity terminal rows and live receipts never add twice. */
import type { Database } from "bun:sqlite";
import type { TurnUsage, PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { priceUsage, type RollupPricing } from "../activity/store.js";
import type { BudgetObservation, TurnBudgetReceipt } from "@schlessera/brain-ui-sdk/protocol";
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
/** Concrete host service; policy is the already frozen admission fact, never reparsed here. */
export function createTurnBudgets(db: Database, pricing: RollupPricing, clock: () => number = Date.now) {
  const active = new Map<string, {
    policy: EffectiveGovernancePolicy;
    route?: PricingRoute;
    pricing: RollupPricing;
  }>();
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
  const receipt = (id: string): TurnBudgetReceipt => {
    const current = active.get(id);
    if (!current) {
      const saved = db.query("SELECT receipt FROM turn_budget_usage WHERE turn_id = ?").get(id) as {
        receipt: string | null;
      } | null;
      if (!saved?.receipt)
        throw new Error("Turn has no frozen budget admission");
      return JSON.parse(saved.receipt) as TurnBudgetReceipt;
    }
    const now = clock(), day = utcBudgetDay(now);
    const ownRow = db.query("SELECT session_id FROM turn_budget_usage WHERE turn_id=?").get(id) as {
      session_id: string | null;
    };
    const all = rows(id, ownRow.session_id, day), own = all.find(row => row.turn_id === id)!;
    const dayRows = new Map((db.query("SELECT turn_id, cost_usd, cost_lower_bound, tokens FROM turn_budget_days WHERE day_start = ?").all(day) as Array<{
      turn_id: string;
      cost_usd: number | null;
      cost_lower_bound: number | null;
      tokens: number | null;
    }>).map(row => [row.turn_id, row]));
    const scopes = (["turn", "session", "day"] as const).map(scope => {
      const selected = scope === "turn" ? [own] : scope === "session" ? all.filter(row => own.session_id !== null && row.session_id === own.session_id) : all.filter(row => row.started_at >= day && row.started_at < day + DAY || dayRows.has(row.turn_id)).map(row => {
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
      const limits = current.policy.budgets[scope];
      const knownCosts = selected.filter(row => row.cost_lower_bound !== null), knownTokens = selected.filter(row => row.tokens !== null);
      const costUsd = selected.length && !knownCosts.length ? null : knownCosts.reduce((sum, row) => sum + row.cost_lower_bound!, 0);
      const tokens = selected.length && !knownTokens.length ? null : knownTokens.reduce((sum, row) => sum + row.tokens!, 0);
      const unknownRuns = selected.filter(row => row.cost_usd === null).length;
      const unpricedMeasured = selected.some(row => row.cost_usd === null && row.tokens !== null);
      return { scope, legacyRuns: selected.filter(row => row.legacy).length, costUsd, tokens, unknownRuns, warnUsd: limits.warn_usd, blockUsd: limits.block_usd,
        blockTokens: limits.block_tokens, ...(limits.warn_tokens !== undefined ? { warnTokens: limits.warn_tokens } : {}),
        ...(scope === "day" ? { resetAt: day + DAY } : {}),
        warning: costUsd !== null && costUsd >= limits.warn_usd || unpricedMeasured && limits.warn_tokens !== undefined && tokens !== null && tokens >= limits.warn_tokens,
        blocked: costUsd !== null && costUsd >= limits.block_usd || unpricedMeasured && tokens !== null && tokens >= limits.block_tokens };
    });
    return { listPriceCostUsd: own.cost_usd, listPriceIsEstimate: own.pricing_estimate === null ? null : Boolean(own.pricing_estimate), tokens: own.tokens, observedAt: now,
      coverage: "Built-in inference only; provider and tool spend is not metered", scopes };
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
    begin(id: string, sessionId: string | undefined, policy: EffectiveGovernancePolicy, route?: PricingRoute) {
      const rates = new Map<string, ReturnType<RollupPricing["resolve"]>>();
      active.set(id, { policy, route, pricing: { resolve(model, route) {
            const key = JSON.stringify([model, route]);
            if (!rates.has(key))
              rates.set(key, structuredClone(pricing.resolve(model, route)));
            return rates.get(key)!;
          } } });
      const result = db.transaction(() => {
        db.query("INSERT INTO turn_budget_usage (turn_id,session_id,started_at,cost_usd,tokens,observed_at) VALUES (?,?,?,NULL,NULL,?) ON CONFLICT(turn_id) DO NOTHING").run(id, sessionId ?? null, clock(), clock());
        const result = receipt(id);
        db.query("UPDATE turn_budget_usage SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(result), id);
        return result;
      }).immediate();
      const blocked = result.scopes.find(item => item.blocked && item.scope !== "turn");
      if (blocked)
        throw new BudgetExceeded(blocked, "admission");
      return result;
    },
    bind(id: string, sessionId: string) { db.query("UPDATE turn_budget_usage SET session_id = ? WHERE turn_id = ?").run(sessionId, id); },
    observe(id: string, usage: TurnUsage) {
      const current = active.get(id);
      if (!current)
        return undefined;
      return db.transaction(() => {
        const previous = db.query("SELECT * FROM turn_budget_usage WHERE turn_id = ?").get(id) as Row;
        const tokens = tokensOf(usage);
        const priced = usage.perModel && Object.keys(usage.perModel).length ? priceUsage(usage.perModel, current.pricing, current.route) : null;
        const cost = priced?.costUsd ?? null;
        const knownPrices = Object.entries(usage.perModel ?? {}).filter(([, counts]) => tokensOf(counts) !== null && tokensOf(counts)! > 0).map(([model, counts]) => priceUsage({ [model]: counts }, current.pricing, current.route)).filter(value => value !== null);
        const partialCost = knownPrices.length ? knownPrices.reduce((sum, value) => sum + value.costUsd, 0) : null;
        const lower = cost ?? (partialCost === null ? previous.cost_lower_bound : Math.max(partialCost, previous.cost_lower_bound ?? 0));
        if (tokens !== null && previous.tokens !== null && tokens < previous.tokens)
          throw new Error("Completed inference receipts must be cumulative");
        const now = clock(), day = utcBudgetDay(now);
        const deltaCost = lower === null ? null : Math.max(0, lower - (previous.cost_lower_bound ?? 0));
        const deltaTokens = tokens === null ? null : tokens - (previous.tokens ?? 0);
        db.query("INSERT INTO turn_budget_days(turn_id,day_start,cost_usd,cost_lower_bound,tokens) VALUES(?,?,?,?,?) ON CONFLICT(turn_id,day_start) DO UPDATE SET cost_usd = CASE WHEN turn_budget_days.cost_usd IS NULL OR excluded.cost_usd IS NULL THEN NULL ELSE turn_budget_days.cost_usd+excluded.cost_usd END, cost_lower_bound = CASE WHEN turn_budget_days.cost_lower_bound IS NULL AND excluded.cost_lower_bound IS NULL THEN NULL ELSE COALESCE(turn_budget_days.cost_lower_bound,0)+COALESCE(excluded.cost_lower_bound,0) END, tokens = CASE WHEN turn_budget_days.tokens IS NULL OR excluded.tokens IS NULL THEN NULL ELSE turn_budget_days.tokens+excluded.tokens END").run(id, day, cost === null ? null : deltaCost, deltaCost, deltaTokens);
        db.query("UPDATE turn_budget_usage SET cost_usd=?,cost_lower_bound=?,pricing_estimate=?,tokens=?,observed_at=? WHERE turn_id=?").run(cost, lower, priced ? Number(priced.estimate) : null, tokens, now, id);
        const result = receipt(id);
        db.query("UPDATE turn_budget_usage SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(result), id);
        const warnings = warningCrossings(id, result);
        return { receipt: result, warnings, blocked: result.scopes.find(item => item.blocked) };
      }).immediate();
    },
    receipt,
    warnings(id: string) { return db.transaction(() => warningCrossings(id, receipt(id))).immediate(); },
    backstop(id: string) {
      const result = receipt(id);
      result.scopes[0] = { ...result.scopes[0]!, blocked: true };
      db.query("UPDATE turn_budget_usage SET receipt=? WHERE turn_id=?").run(JSON.stringify(result), id);
      return result;
    },
    saved(id: string): TurnBudgetReceipt | undefined {
      // Presentation must not turn a missing accounting receipt into a failed journal observation.
      try {
        const row = db.query("SELECT receipt FROM turn_budget_usage WHERE turn_id = ?").get(id) as {
          receipt: string | null;
        } | null;
        return row?.receipt ? JSON.parse(row.receipt) : undefined;
      }
      catch {
        return undefined;
      }
    },
    remaining(id: string) { const own = receipt(id).scopes[0]!; return Math.max(0, own.blockUsd - (own.costUsd ?? 0)); },
    end(id: string) { active.delete(id); },
  };
}
export type TurnBudgets = ReturnType<typeof createTurnBudgets>;
/** The same server measurement supplied to the receipt; advisory text never enforces or grants. */
export function inferenceBudgetNote(receipt: TurnBudgetReceipt): string {
  return `[Host inference capabilities: ${receipt.coverage}. These are list-price usage limits, not subscription invoices. ${receipt.scopes.map(item => `${item.scope}: ${item.costUsd === null ? "price unknown" : `$${item.costUsd} known lower bound`}; warn $${item.warnUsd}; stop $${item.blockUsd}; unpriced token stop ${item.blockTokens}${item.resetAt ? `; resets ${new Date(item.resetAt).toISOString()}` : ""}${item.warning ? "; WARNING threshold reached" : ""}`).join(". ")}. Warnings are visual only in voice posture; do not speak them. Stops preserve partial work for review.]`;
}

/** Configured limits only: no observation timestamp, reset time or running usage. */
export function inferenceBudgetLimits(receipt: TurnBudgetReceipt): string {
  return `Host inference limits (list-price limits, not subscription invoices; ${receipt.coverage}): ${receipt.scopes.map(item => `${item.scope}: warn $${item.warnUsd}; stop $${item.blockUsd}; unpriced token warn ${item.warnTokens ?? "unconfigured"}; stop ${item.blockTokens}`).join(". ")}. Stops preserve partial work for review.`;
}
/** Actionable state only; a stable warning does not become a routine usage ticker. */
export function inferenceBudgetContext(receipt: TurnBudgetReceipt): string | undefined {
  const warnings = receipt.scopes.filter(item => item.warning).map(item => `${item.scope} warning threshold reached${item.scope === "day" && item.resetAt ? ` until ${new Date(item.resetAt).toISOString()}` : ""}; finish the current result within the remaining limit and preserve partial work. Warnings are visual only in voice posture; do not speak them.`);
  return warnings.length ? warnings.join("\n") : undefined;
}
