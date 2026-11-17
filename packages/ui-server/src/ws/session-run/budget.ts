import type { BudgetObservation, TurnUsage } from "@schlessera/brain-ui-sdk/protocol";
import { BudgetExceeded, BudgetUnavailable } from "../../brain/turn-budgets.js";
import type { GovernanceEventInput } from "../../governance/events.js";
import { withTurnScope } from "../frames.js";
import type { TurnRun } from "./types.js";

/** Who a budget event is recorded for: the turn as it is when the event is written. */
export interface BudgetAttribution {
  readonly turnId: string;
  readonly sessionId: string | null;
  readonly actor: "voice" | "interactive";
  readonly model: string | null;
  readonly profile: NonNullable<GovernanceEventInput["profile"]>;
  /** Whether the limits came from the brain's policy or the defaults. */
  readonly source: "policy" | "default";
}

type BudgetBlockStage = "admission" | "mid_turn" | "sdk_backstop";

/** Read a budget event's attribution from the live turn. */
export function budgetAttribution(run: Pick<TurnRun, "turn" | "origin" | "mainModel" | "held">): BudgetAttribution {
  const hold = run.held.governedHold;
  return {
    turnId: run.turn.turnId,
    sessionId: run.turn.sessionId,
    actor: run.origin,
    model: run.mainModel,
    profile: hold?.sandbox.profile ?? "strict",
    source: hold?.policy.hash ? "policy" : "default",
  };
}

/**
 * The `budget_warning` or `budget_block` governance event for one budget
 * observation. A scope is reported in dollars once its cost crosses the
 * limit in question, otherwise in tokens; the SDK backstop is always dollars.
 */
export function budgetEvent(kind: "budget_warning", item: BudgetObservation, attribution: BudgetAttribution): GovernanceEventInput<"budget_warning">;
export function budgetEvent(kind: "budget_block", item: BudgetObservation, attribution: BudgetAttribution, stage: BudgetBlockStage): GovernanceEventInput<"budget_block">;
export function budgetEvent(
  kind: "budget_warning" | "budget_block",
  item: BudgetObservation,
  attribution: BudgetAttribution,
  stage?: BudgetBlockStage
): GovernanceEventInput<"budget_warning"> | GovernanceEventInput<"budget_block"> {
  const { turnId, sessionId, actor, model, profile, source } = attribution;
  if (kind === "budget_warning") {
    const usd = item.costUsd !== null && item.costUsd >= item.warnUsd;
    return { kind, turnId, sessionId, actor, model, profile,
      payload: { scope: item.scope, unit: usd ? "usd" : "tokens", limit: usd ? item.warnUsd : item.warnTokens!,
        observed: usd ? item.costUsd! : item.tokens!, source } };
  }
  const backstop = stage === "sdk_backstop";
  const usd = backstop || item.costUsd !== null && item.costUsd >= item.blockUsd;
  return { kind, turnId, sessionId, actor, model, profile,
    payload: { scope: item.scope, unit: usd ? "usd" : "tokens", limit: usd ? item.blockUsd : item.blockTokens,
      observed: backstop ? item.costUsd ?? 0 : usd ? item.costUsd! : item.tokens!, source, stage: stage! } };
}

/** One governed turn's mid-turn budget accounting: warnings, blocks and write commits. */
export interface TurnBudget {
  /** Record each warning of one observation. */
  warn(warnings: readonly BudgetObservation[]): void;
  /** Stop the turn on a crossed block, the agent's own or the SDK backstop's. */
  block(item: BudgetObservation, backstop: boolean): void;
  /** Stop the turn because its accounting cannot be trusted any more. */
  unavailable(): void;
  /** Track a budget write's commit and what the turn does with its outcome. */
  write(work: Promise<unknown>): void;
  /** The bridge's usage report: price it now, commit and judge it later (#2850). */
  observeUsage(usage: TurnUsage, backstop?: boolean): TurnUsage | undefined;
}

/**
 * Mid-turn accounting for one budgeted, governed turn: the agent's own
 * inference or a relayed CLI provider request (#1673). A block or an
 * accounting failure stops the turn through {@link TurnRun.stops}.
 */
export function createTurnBudget(run: TurnRun): TurnBudget {
  const { host, turn, abortController, recorder, stops, budgetWrites } = run;
  const budgets = host.budgets!;
  const unavailable = () => {
    stops.budget = new BudgetUnavailable();
    recorder?.recordBudgetStop(stops.budget.message, "budget_unavailable");
    abortController.abort(stops.budget); host.coordinator.drainPendingForTurn(turn, "Inference budget accounting became unavailable.");
  };
  const block = (item: BudgetObservation, backstop: boolean) => {
    host.activity?.governance?.(budgetEvent("budget_block", item, budgetAttribution(run), backstop ? "sdk_backstop" : "mid_turn"));
    stops.budget = new BudgetExceeded(item, backstop ? "sdk_backstop" : "mid_turn");
    recorder?.recordBudgetStop(stops.budget.message);
    abortController.abort(stops.budget); host.coordinator.drainPendingForTurn(turn, stops.budget.message);
  };
  const warn = (warnings: readonly BudgetObservation[]) => {
    for (const item of warnings) host.activity?.governance?.(budgetEvent("budget_warning", item, budgetAttribution(run)));
  };
  const write = (work: Promise<unknown>) => {
    const pending = work.catch(() => { if (!stops.budget) unavailable(); }).finally(() => budgetWrites.delete(pending));
    budgetWrites.add(pending);
  };
  const observeUsage = (usage: TurnUsage, backstop = false): TurnUsage | undefined => {
    if (stops.budget || abortController.signal.aborted || turn.cancelled) return;
    // The report is priced now; its receipt, warnings and any block
    // follow its commit (#2850), judged against the turn as it is then.
    const live = () => !stops.budget && !abortController.signal.aborted && !turn.cancelled;
    try {
      if (backstop) {
        write(budgets.backstop(turn.turnId).then(saved => { if (live()) block({ ...saved.scopes[0]!, blocked: true }, true); }));
        return;
      }
      const observed = budgets.observe(turn.turnId, usage);
      if (!observed) return;
      const listPrice = budgets.listPrice(turn.turnId, usage);
      write(observed.then(result => {
        if (!live()) return;
        warn(result.warnings);
        const { costUsd: reportedCost, ...counts } = usage;
        void reportedCost;
        host.sendToClients(withTurnScope({ type: "usage", turnId: turn.turnId, usage: { ...counts,
          ...(result.receipt.listPriceCostUsd !== null ? { costUsd: result.receipt.listPriceCostUsd } : {}) },
          observedAt: result.receipt.observedAt, budget: result.receipt }, turn));
        if (result.blocked) block(result.blocked, false);
      }));
      return { ...usage, ...(listPrice !== null ? { costUsd: listPrice } : {}) };
    } catch { unavailable(); }
  };
  return { warn, block, unavailable, write, observeUsage };
}

/** Wait for every budget write the turn started, including any a commit started. */
export async function settleBudgetWrites(run: Pick<TurnRun, "budgetWrites">): Promise<void> {
  while (run.budgetWrites.size) await Promise.all([...run.budgetWrites]);
}
