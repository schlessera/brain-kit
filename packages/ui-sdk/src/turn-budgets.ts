/** Server-measured list-price inference facts, separate from effective billed cost. */
export type BudgetScope = "turn" | "session" | "day";
export interface BudgetObservation {
  scope: BudgetScope;
  legacyRuns?: number;
  costUsd: number | null;
  /**
   * Admitted Apify liability (#3307), USD, already included in `costUsd`.
   * Present only when the host's Apify ledger was read for this receipt.
   */
  apifyUsd?: number;
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
 * keeps the earlier statement. Since 0.45.0 (#3307) a host with an Apify
 * ledger also counts the Apify liability it admitted, or says that ledger was
 * unavailable and its spend is not counted. `listPriceCostUsd` and `tokens`
 * stay the agent's own completed inference.
 */
export type TurnBudgetCoverage =
  | "Built-in inference, relayed brain CLI providers and Apify runs this host admitted; other provider and tool spend is not metered"
  | "Built-in inference and relayed brain CLI providers; Apify accounting is unavailable, so Apify spend is not counted; other provider and tool spend is not metered"
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
