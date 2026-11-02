/**
 * The Apify ledger as a source for the global inference turn budgets (#3307,
 * [the contract](../../../../docs/decisions/apify-capability.md#selected-execution-eligibility-and-monetary-enforcement)).
 *
 * The global `budgets` belong to one brain, so they read the liability the
 * ledger holds for this brain: the turn, its session and this brain's UTC day
 * (`brain_day`, which keeps an unsettled run on every later day until it
 * settles). The account-wide day is Apify's own ceiling (`apify.limits.day_usd`),
 * not a global budget scope, and is not read here. Outside a turn, or before a
 * session is bound, the turn and session scopes hold nothing: every Apify run
 * belongs to a turn and a session.
 *
 * Any failure to open or read the ledger throws, and the turn budgets report
 * Apify accounting as unavailable instead of counting zero.
 */
import type { ApifyBudgetSource } from "../brain/turn-budgets.js";
import type { ApifyLedger } from "@schlessera/brain/internal/apify";

export function apifyBudgetSource(ledger: () => ApifyLedger, brain_id: string): ApifyBudgetSource {
  return (scope, now) => {
    // Empty identities match no run: every stored run has a real account, session and turn.
    const totals = ledger().totals({ account_id: "", brain_id, session_id: scope.session_id ?? "", turn_id: scope.turn_id ?? "" }, now);
    const usd = (micro: number) => micro / 1e6;
    return {
      turn_usd: scope.session_id === null ? 0 : usd(totals.turn.liability_micro),
      session_usd: scope.session_id === null ? 0 : usd(totals.session.liability_micro),
      day_usd: usd(totals.brain_day.liability_micro),
    };
  };
}
