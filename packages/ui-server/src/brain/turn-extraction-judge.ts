/**
 * One turn's extraction judge (#4089): the host's Jev client behind the
 * turn's data routing (G2) and budgets.
 *
 * - **Routing.** TypeSafe is a recipient in the provider policy's sense, as a
 *   web provider is: the request it is shown can quote any folder the model
 *   was shown. Nothing is sent from a conversation that has shown it a folder
 *   the policy keeps from `typesafe`, and an exposure the host cannot judge
 *   sends nothing (`webRoutingRefusal`, `packages/ui-server/src/web-tools/routing.ts`).
 * - **Budget.** A blocked scope, or accounting that cannot answer, sends
 *   nothing. Each request is recorded as its own operation,
 *   `extraction_judge`, against the turn, its conversation and its UTC day,
 *   with the usage TypeSafe reports; no rate is held for it, so its tokens
 *   count toward the token stops and its cost is unknown, never zero.
 *
 * Whatever stops the call leaves the band on the card.
 */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import type { JevClient } from "../classification/jev-client.js";
import { createExtractionJudge, EXTRACTION_JUDGE_RECIPIENT, type ExtractionJudge } from "../governance/extraction-judge.js";
import { webRoutingRefusal } from "../web-tools/routing.js";
import type { ProviderExposure } from "./governance-policy.js";
import { BudgetExceeded, type TurnBudgets } from "./turn-budgets.js";

export function turnExtractionJudge(options: {
  client: JevClient | undefined;
  policy: EffectiveGovernancePolicy;
  turnId: string;
  sessionId: () => string | null;
  /** The conversation's recorded provider exposures; absent, routing cannot be judged. */
  exposures?: (sessionIds: readonly string[]) => Promise<ProviderExposure[]>;
  typeFolders?: Readonly<Record<string, readonly string[]>>;
  budgets: Pick<TurnBudgets, "providerAdmission"> | undefined;
  /** Why the turn can no longer spend (stopped, over budget), or null. */
  stopped(): string | null;
  /** Records one attempt receipt, as the turn's relay records its own. */
  observe(receipt: ProviderRelayReceipt): void;
}): ExtractionJudge | undefined {
  const { client, policy } = options;
  if (!client || policy.taint.classifier !== "heuristics" || policy.taint.judge.mode !== "jev") return undefined;
  return createExtractionJudge({
    client, floor: policy.taint.judge.floor, observe: options.observe,
    async admit() {
      const stopped = options.stopped();
      if (stopped) return stopped;
      // Before the conversation is named, nothing recorded says what it showed.
      const named = options.sessionId();
      const shown = named && options.exposures ? await options.exposures([named]) : undefined;
      const routed = webRoutingRefusal(policy, options.typeFolders, shown, EXTRACTION_JUDGE_RECIPIENT);
      if (routed) return routed.message;
      // Nothing to charge it to is no reason to send it.
      if (!options.budgets) return "Budget accounting is unavailable for this turn, so nothing was sent.";
      const blocked = await options.budgets.providerAdmission(options.turnId, policy);
      return blocked ? new BudgetExceeded(blocked, "mid_turn").message : null;
    },
  });
}
