/** Server-measured list-price inference facts, separate from effective billed cost. */
export type BudgetScope = "turn" | "session" | "day";
export interface BudgetObservation {
  scope: BudgetScope;
  legacyRuns?: number;
  costUsd: number | null;
  tokens: number | null;
  unknownRuns: number;
  warnUsd: number;
  blockUsd: number;
  blockTokens: number;
  warnTokens?: number;
  resetAt?: number;
  warning: boolean;
  blocked: boolean;
}
/**
 * What a receipt's scopes meter. Since 0.44.0 (#1673) they include the `brain`
 * CLI's provider requests through the host relay; a receipt stored before then
 * keeps the earlier statement. `listPriceCostUsd` and `tokens` stay the
 * agent's own completed inference.
 */
export type TurnBudgetCoverage =
  | "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered"
  | "Built-in inference only; provider and tool spend is not metered";
export interface TurnBudgetReceipt {
  listPriceCostUsd: number | null;
  listPriceIsEstimate?: boolean | null;
  tokens: number | null;
  observedAt: number;
  coverage: TurnBudgetCoverage;
  scopes: BudgetObservation[];
}
