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
export interface TurnBudgetReceipt {
  listPriceCostUsd: number | null;
  listPriceIsEstimate?: boolean | null;
  tokens: number | null;
  observedAt: number;
  coverage: "Built-in inference only; provider and tool spend is not metered";
  scopes: BudgetObservation[];
}
