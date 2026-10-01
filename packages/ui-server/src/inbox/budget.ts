/** Concrete operational accounting. No model call or I/O joins these transactions. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { BillingMode, InboxQueueItem, PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { ModelPricing, PricingRates } from "../pricing/model-pricing.js";
import { createInboxStore, type InboxReservation } from "./store.js";

export interface InboxBudgetConfig {
  spendUsd: number;
  turns: number;
  emergencySpendUsd: number;
  emergencyTurns: number;
  timeZone: string;
  unpricedUsdPerToken: number;
}
/** Conservative counts and billing are selected by server code, covering the
 * whole operation including internal requests. These are admission estimates,
 * not transport-enforced limits or values submitted by a model/client. API
 * work needs usable counts. Retries/redo are separate operations; compaction
 * folded into a call belongs in that call's estimate.
 */
export interface InboxBudgetOperation {
  runId: string;
  principalId: string;
  model: string;
  billingMode: BillingMode;
  pricingRoute?: PricingRoute;
  purpose: InboxReservation["purpose"];
  maximumTokens?: Tokens;
  /** Explicit server decision; priority suggestions cannot select this. */
  emergency?: boolean;
}
interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
interface PricingSnapshot {
  route?: PricingRoute;
  rates: PricingRates | null;
  unpricedUsdPerToken: number;
  maximumTokens?: Tokens;
  missingUsageCostUsd: number;
  unpriced: boolean;
}
interface ReservationRow {
  id: string;
  item_id: string;
  run_id: string | null;
  attempt: number;
  principal_id: string;
  model: string;
  billing_mode: BillingMode;
  local_day: string;
  reserve_kind: "normal" | "emergency";
  reserved_cost_usd: number;
  reserved_turns: number;
  charged_cost_usd: number | null;
  charged_turns: number | null;
  observed_cost_usd: number | null;
  pricing_json: string | null;
  status: string;
  runtime_acquired_at: number | null;
}
const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
const DAY_MS = 86_400_000;
const MICROS = 1_000_000;
function money(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.ceil(value * MICROS)))
    throw new Error("Invalid autonomous budget money");
  return Math.ceil(value * MICROS);
}
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid autonomous budget count");
  return value;
}
export function inboxBudgetDay(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function tokens(value: unknown, requireComplete = false): Tokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // An empty per-model object is missing evidence, never a zero-token receipt.
  if (!TOKEN_KEYS.some((key) => typeof raw[key] === "number")) return null;
  if (requireComplete && !TOKEN_KEYS.every((key) => typeof raw[key] === "number")) return null;
  const result = {} as Tokens;
  for (const key of TOKEN_KEYS) {
    const n = raw[key] ?? 0;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    result[key] = n;
  }
  return result;
}
function tokenTotal(t: Tokens): number { return count(TOKEN_KEYS.reduce((n, key) => n + t[key], 0)); }
function tokenCost(t: Tokens, rates: PricingRates | null, pessimistic: number): { cost: number; unpriced: boolean } {
  const prices = [rates?.input, rates?.output, rates?.cacheRead, rates?.cacheWrite];
  let cost = 0, unpriced = false;
  TOKEN_KEYS.forEach((key, i) => {
    if (t[key] === 0) return;
    const rate = prices[i];
    if (rate == null || !Number.isFinite(rate) || rate < 0) { cost += t[key] * pessimistic; unpriced = true; }
    else cost += t[key] * rate;
  });
  money(cost);
  return { cost, unpriced };
}
function reservation(db: Database, runId: string): ReservationRow | null {
  const rows = db.query("SELECT * FROM inbox_budget_reservations WHERE run_id = ?").all(runId) as ReservationRow[];
  // Preserve legacy rows, but never execute/settle an ambiguous ownership join.
  if (rows.length > 1) throw new Error("Ambiguous autonomous reservation");
  return rows[0] ?? null;
}
function snapshot(row: ReservationRow): PricingSnapshot | null {
  return row.pricing_json ? JSON.parse(row.pricing_json) as PricingSnapshot : null;
}
function notice(db: Database, itemId: string, classKey: string, title: string, detail: string, action: boolean, now: number): void {
  if (db.query("SELECT 1 FROM inbox_suppressions WHERE class_key = ?").get(classKey)) return;
  // An item may already be tombstoned during lease recovery. Its retained
  // thread can still receive a notice; a removed/closed thread stays removed.
  // Display lifecycle must never prevent conservative spend reconciliation.
  const owner = db.query(`SELECT i.thread_id AS threadId FROM inbox_items i
    JOIN inbox_threads t ON t.id = i.thread_id WHERE i.id = ? AND t.deleted_at IS NULL AND t.status = 'open'`)
    .get(itemId) as { threadId: string } | null;
  if (!owner) return;
  const store = createInboxStore(db, { now: () => now });
  const id = `budget-${createHash("sha256").update(classKey).digest("hex")}`;
  store.commit([{ kind: "item", item: {
    id, threadId: owner.threadId, dedupKey: id, queue: "actions", type: action ? "choose" : "fyi",
    status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 30 * DAY_MS,
    payload: { title, detail }, options: action ? [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] : [],
  } }, { kind: "suppress", classKey, evidenceBoundary: classKey, expiresAt: Number.MAX_SAFE_INTEGER,
    reraiseCondition: "A different model or budget day has a different class key." }]);
}
function unpricedNotice(db: Database, row: Pick<ReservationRow, "item_id" | "model">, model: string, now: number): void {
  const key = `budget-price:${createHash("sha256").update(model).digest("hex")}`;
  notice(db, row.item_id, key, "An autonomous model has no resolvable price",
    `Model ${model} is charged pessimistically. Pin a rate or switch models before relying on its cost.`, true, now);
}

/** Constructed by the runtime/engine, never exported as a storage-provider seam. */
export function createInboxBudget(db: Database, deps: {
  config: InboxBudgetConfig;
  pricing: Pick<ModelPricing, "resolve">;
  now?: () => number;
  maxAutonomousRuns?: number;
}) {
  const config = Object.freeze({ ...deps.config }), now = deps.now ?? Date.now;
  const maxAutonomousRuns = deps.maxAutonomousRuns ?? 2;
  if (!Number.isSafeInteger(maxAutonomousRuns) || maxAutonomousRuns < 1)
    throw new Error("MAX_AUTONOMOUS_RUNS must be a positive integer");
  for (const value of [config.spendUsd, config.emergencySpendUsd, config.unpricedUsdPerToken]) money(value);
  for (const value of [config.turns, config.emergencyTurns]) count(value);
  if (config.unpricedUsdPerToken === 0) throw new Error("Unpriced autonomous rate must be positive");
  inboxBudgetDay(now(), config.timeZone);
  const store = createInboxStore(db, { now });

  function totals(day: string) {
    const rows = db.query("SELECT * FROM inbox_budget_reservations WHERE local_day = ?").all(day) as ReservationRow[];
    const normal = { cost: 0, turns: 0 }, emergency = { cost: 0, turns: 0 };
    let unpricedRuns = 0;
    for (const row of rows) {
      const bucket = row.reserve_kind === "emergency" ? emergency : normal;
      bucket.cost += money(row.status === "active" ? row.reserved_cost_usd : row.charged_cost_usd ?? row.reserved_cost_usd);
      bucket.turns += count(row.status === "active" ? row.reserved_turns : row.charged_turns ?? row.reserved_turns);
      if (row.status === "active" ? row.billing_mode !== "subscription" && (snapshot(row)?.unpriced ?? snapshot(row)?.rates == null) : row.observed_cost_usd == null) unpricedRuns++;
    }
    // Bound the UTC scan, then filter by the exact local calendar (DST included).
    const utcDay = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(utcDay) || new Date(utcDay).toISOString().slice(0, 10) !== day)
      throw new Error("Invalid autonomous budget day");
    // Existing/unaccounted autonomous Activity is not a free hole. Restrict by
    // origin and omit reservation-backed runs to avoid counting them twice.
    const history = db.query(`SELECT run_id, started_at, effective_cost_usd FROM activity_run_rollups
      WHERE origin = 'autonomous' AND started_at >= ? AND started_at < ?
      AND NOT EXISTS (SELECT 1 FROM inbox_budget_reservations r WHERE r.run_id = activity_run_rollups.run_id)
      UNION ALL SELECT run_id, started_at, NULL FROM activity_spans s WHERE origin = 'autonomous' AND parent_span_id IS NULL
      AND started_at >= ? AND started_at < ?
      AND NOT EXISTS (SELECT 1 FROM activity_run_rollups h WHERE h.run_id = s.run_id)
      AND NOT EXISTS (SELECT 1 FROM inbox_budget_reservations r WHERE r.run_id = s.run_id)`)
      .all(utcDay - DAY_MS, utcDay + 2 * DAY_MS, utcDay - DAY_MS, utcDay + 2 * DAY_MS) as Array<{ started_at: number; effective_cost_usd: number | null }>;
    for (const run of history) {
      if (inboxBudgetDay(run.started_at, config.timeZone) !== day) continue;
      normal.cost += money(run.effective_cost_usd ?? config.spendUsd + config.emergencySpendUsd);
      normal.turns++;
      if (run.effective_cost_usd === null) unpricedRuns++;
    }
    if (![normal.cost, normal.turns, emergency.cost, emergency.turns].every(Number.isSafeInteger)) throw new Error("Autonomous budget overflow");
    return { normal, emergency, unpricedRuns };
  }

  function admit(ids: string[], op: InboxBudgetOperation, leaseUntil?: number) {
    return db.transaction(() => {
      const at = now(), day = inboxBudgetDay(at, config.timeZone);
      if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Invalid budget claim items");
      const items = ids.map((id) => store.getItem(id));
      if (items.some((item) => !item || item.queue !== "queue" || item.expiresAt <= at ||
        (leaseUntil === undefined ? item.status !== "claimed" || item.leaseUntil! <= at :
          item.status !== "ready" || (item.waitUntil ?? 0) > at || item.attempts >= item.maxAttempts))) return null;
      if (![op.runId, op.principalId, op.model].every((s) => typeof s === "string" && s.length > 0 && s.length <= 256) ||
        !["api", "subscription"].includes(op.billingMode)) throw new Error("Invalid autonomous budget identity");
      if (reservation(db, op.runId)) throw new Error("Autonomous run already reserved");
      // Reservation and lease admission share this immediate transaction.
      // Count operations rather than batch items. Terminal settlement occurs
      // after backend unwind, so an in-flight writer cannot free its slot early.
      const { active } = db.query("SELECT COUNT(*) AS active FROM inbox_budget_reservations WHERE status = 'active'")
        .get() as { active: number };
      if (active >= maxAutonomousRuns) return null;
      const bounded = op.maximumTokens ? tokens(op.maximumTokens, true) : null;
      if (op.maximumTokens && !bounded) throw new Error("Invalid autonomous token bounds");
      const rates = deps.pricing.resolve(op.model, op.pricingRoute);
      if (op.billingMode === "api" && (!bounded || tokenTotal(bounded) === 0)) {
        if (!rates) unpricedNotice(db, { item_id: ids[0]!, model: op.model }, op.model, at);
        return null;
      }
      const priced = op.billingMode === "subscription" ? { cost: 0, unpriced: false } : tokenCost(bounded!, rates, config.unpricedUsdPerToken);
      const turns = 1;
      const usage = totals(day), totalCost = usage.normal.cost + usage.emergency.cost, totalTurns = usage.normal.turns + usage.emergency.turns;
      const cost = money(priced.cost), bucket = op.emergency ? usage.emergency : usage.normal;
      const bucketCostCap = money(op.emergency ? config.emergencySpendUsd : config.spendUsd);
      const bucketTurnCap = op.emergency ? config.emergencyTurns : config.turns;
      // Both the chosen pool and the absolute combined ceiling hold. A normal
      // overrun cannot turn the emergency pool into an unbounded exception.
      if (bucket.cost + cost > bucketCostCap || bucket.turns + turns > bucketTurnCap ||
        totalCost + cost > money(config.spendUsd + config.emergencySpendUsd) ||
        totalTurns + turns > config.turns + config.emergencyTurns) {
        notice(db, ids[0]!, `budget-cap:${day}`, "Autonomous work reached its budget",
          "Further work is paused at the configured spend or turn cap. Only explicitly eligible work within the bounded emergency reserve can still start.", false, at);
        return null;
      }
      const owner = items[0] as InboxQueueItem;
      const id = `reservation-${createHash("sha256").update(op.runId).digest("hex")}`;
      const pricing: PricingSnapshot = { route: op.pricingRoute, rates, maximumTokens: bounded ?? undefined,
        unpricedUsdPerToken: config.unpricedUsdPerToken, unpriced: priced.unpriced,
        missingUsageCostUsd: (bounded ? tokenCost(bounded, rates, config.unpricedUsdPerToken).cost : 0) || config.spendUsd + config.emergencySpendUsd || config.unpricedUsdPerToken };
      store.commit([
        ...(leaseUntil === undefined ? [] : items.map((item) => ({ kind: "transition" as const, itemId: item!.id,
          expectedVersion: item!.version, to: "claimed" as const, leaseUntil, runId: op.runId }))),
        { kind: "reserve", reservation: { id, operationKey: op.runId, itemId: owner.id,
          attempt: owner.attempts + (leaseUntil === undefined ? 0 : 1), purpose: op.purpose, runId: op.runId,
          principalId: op.principalId, model: op.model, billingMode: op.billingMode, localDay: day,
          reserveKind: op.emergency ? "emergency" : "normal", reservedCostUsd: cost / MICROS, reservedTurns: turns } },
      ]);
      db.query("UPDATE inbox_budget_reservations SET pricing_json = ? WHERE id = ?").run(JSON.stringify(pricing), id);
      if (priced.unpriced) unpricedNotice(db, { item_id: owner.id, model: op.model }, op.model, at);
      return { reservationId: id, runId: op.runId, items: ids.map((id) => store.getItem(id) as InboxQueueItem) };
    }).immediate();
  }
  return {
    claim: (ids: string | string[], op: InboxBudgetOperation, leaseUntil: number) => admit(typeof ids === "string" ? [ids] : ids, op, leaseUntil),
    reserve: (itemId: string, op: InboxBudgetOperation) => admit([itemId], op),
    totals: (day = inboxBudgetDay(now(), config.timeZone)) => db.transaction(() => totals(day))(),
    settle: (runId: string, status: "settled" | "released" = "settled") => db.transaction(() => settleInboxBudgetRun(db, runId, status, now(), deps.pricing)).immediate(),
    recover: () => reconcileInboxBudgets(db, now()),
  };
}

/** Acquire exactly once immediately before the concrete backend/transport starts. */
export function acquireInboxBudgetRun(db: Database, runId: string, principalId: string, now = Date.now()): void {
  db.transaction(() => {
    const row = reservation(db, runId);
    if (!row || row.status !== "active" || row.principal_id !== principalId || row.runtime_acquired_at !== null)
      throw new Error("Autonomous inference requires an unused active budget reservation");
    const item = createInboxStore(db).getItem(row.item_id);
    if (!item || item.queue !== "queue" || item.status !== "claimed" || item.attempts !== row.attempt || item.leaseUntil! <= now)
      throw new Error("Autonomous budget lease is no longer active");
    db.query("UPDATE inbox_budget_reservations SET runtime_acquired_at = ? WHERE id = ?").run(now, row.id);
  }).immediate();
}

/** Also called inside Activity's rollup transaction, using its frozen receipt. */
export function settleInboxBudgetRun(db: Database, runId: string, status: "settled" | "released" = "settled", now = Date.now(), pricing?: Pick<ModelPricing, "resolve">): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inbox_budget_reservations'").get()) return false;
  const row = reservation(db, runId);
  if (!row || row.status !== "active") return false;
  const root = db.query("SELECT attrs, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, origin FROM activity_spans WHERE run_id = ? AND parent_span_id IS NULL ORDER BY started_at LIMIT 1").get(runId) as {
    attrs: string | null; cost_usd: number | null; origin: string;
  } | null;
  const rollup = db.query("SELECT effective_cost_usd, billing_mode, origin, ended_at FROM activity_run_rollups WHERE run_id = ?").get(runId) as {
    effective_cost_usd: number | null; billing_mode: BillingMode | null; origin: string; ended_at: number | null;
  } | null;
  if (status === "settled" && rollup?.ended_at == null) return false;
  if (root && root.origin !== "autonomous" || rollup && rollup.origin !== "autonomous") throw new Error("Budget run has a non-autonomous origin");
  const attrs = root?.attrs ? JSON.parse(root.attrs) as Record<string, unknown> : {};
  const observedBilling = attrs["brain.billing_observed"];
  const confirmedBilling = observedBilling === "api" || observedBilling === "subscription" ? observedBilling :
    observedBilling === undefined ? rollup?.billing_mode ?? row.billing_mode : null;
  const billing = confirmedBilling === "subscription" ? "subscription" : "api";
  const frozen = snapshot(row);
  const perModel = attrs["gen_ai.usage.per_model"];
  let usable = false, complete = true, cost = 0, unpriced = false;
  if (perModel && typeof perModel === "object" && !Array.isArray(perModel)) {
    const entries = Object.entries(perModel);
    for (const [model, value] of entries) {
      const t = tokens(value);
      if (!t) { complete = false; continue; }
      if (!tokens(value, true)) complete = false;
      usable = true;
      const rates = model === row.model ? frozen?.rates ?? null : pricing?.resolve(model, frozen?.route) ?? null;
      const priced = tokenCost(t, rates, frozen?.unpricedUsdPerToken ?? 0.01);
      cost += priced.cost; unpriced ||= priced.unpriced;
      if (priced.unpriced && billing !== "subscription" && rollup?.effective_cost_usd == null) unpricedNotice(db, row, model, now);
    }
    if (entries.length === 0) complete = false;
  }
  // Missing receipts keep the conservative amount. A crash/abort cannot prove
  // the last in-flight request was free; known spend is a lower bound.
  const observed = confirmedBilling === null ? null : billing === "subscription" ? 0 : usable && complete
    ? (rollup?.effective_cost_usd != null && rollup.billing_mode === "api" ? rollup.effective_cost_usd : unpriced ? null : cost) : null;
  let charged = billing === "subscription" ? 0 : observed ?? (usable && complete ? cost : row.reserved_cost_usd);
  if (billing !== "subscription") {
    if (!usable || !complete || confirmedBilling === null)
      charged = Math.max(charged, cost, row.reserved_cost_usd, frozen?.missingUsageCostUsd ?? row.reserved_cost_usd);
    if (root?.cost_usd != null) charged = Math.max(charged, root.cost_usd);
    if ((unpriced || frozen?.rates == null) && rollup?.effective_cost_usd == null) unpricedNotice(db, row, row.model, now);
  }
  // Recovery with incomplete work retains the whole amount in addition to any
  // larger observed lower bound. Only a terminal complete receipt releases it.
  if (status === "released" && billing !== "subscription" && rollup?.ended_at == null)
    charged = Math.max(charged, row.reserved_cost_usd);
  charged = money(charged) / MICROS;
  db.query("UPDATE inbox_budget_reservations SET status = ?, observed_cost_usd = ?, charged_cost_usd = ?, charged_turns = ?, observed_billing_mode = ?, settled_at = ? WHERE id = ? AND status = 'active'")
    .run(status, observed, charged, row.reserved_turns, confirmedBilling, now, row.id);
  return true;
}

/** Runs before recovered items are made ready and before any new admission. */
export function reconcileInboxBudgets(db: Database, now = Date.now()): number {
  return db.transaction(() => {
    const rows = db.query(`SELECT r.* FROM inbox_budget_reservations r JOIN inbox_items i ON i.id = r.item_id
      WHERE r.status = 'active' AND (i.deleted_at IS NOT NULL OR i.status != 'claimed' OR i.lease_until <= ? OR i.attempts != r.attempt)`).all(now) as ReservationRow[];
    let recovered = 0;
    for (const row of rows) {
      if (row.run_id && settleInboxBudgetRun(db, row.run_id, "released", now)) recovered++;
      else if (!row.run_id) {
        db.query("UPDATE inbox_budget_reservations SET status = 'released', charged_cost_usd = reserved_cost_usd, charged_turns = reserved_turns, settled_at = ? WHERE id = ?").run(now, row.id);
        recovered++;
      }
    }
    return recovered;
  }).immediate();
}
