/**
 * Budget admission and accounting for the CLI provider relay of credentialed
 * maintenance runs (#1673). A run a turn's tool started is charged to that
 * turn; any other run (a user search, a cron job, a module action) to its
 * UTC day alone, under the brain's current governance policy.
 */
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import type { HostBoundaryOptions } from "./host-boundary.js";
import { createGovernancePolicyReader } from "./governance-policy.js";
import { BudgetExceeded, BudgetUnavailable, type TurnBudgets } from "./turn-budgets.js";

export function maintenanceProviderMeter(options: {
  brainPath: string;
  origins?: ReadonlyMap<string, readonly string[]>;
  /** The host's budgets; undefined until they exist, which refuses relayed requests. */
  budgets(): TurnBudgets | undefined;
  report(message: string): void;
}): NonNullable<HostBoundaryOptions["providerRelay"]> {
  const policy = createGovernancePolicyReader(options.brainPath);
  return {
    ...(options.origins ? { origins: options.origins } : {}),
    admit(turnId) {
      const budgets = options.budgets();
      if (!budgets) return { allowed: false, message: new BudgetUnavailable().message };
      try {
        const blocked = budgets.providerAdmission(turnId, policy.load().policy);
        return blocked ? { allowed: false, message: new BudgetExceeded(blocked, "mid_turn").message } : { allowed: true };
      } catch { return { allowed: false, message: new BudgetUnavailable().message }; }
    },
    observe(turnId: string | null, attempt: ProviderRelayReceipt) {
      try { options.budgets()?.observeProvider(turnId, attempt); }
      catch (error) { options.report(`a relayed provider request could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}
