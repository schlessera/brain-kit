/**
 * Data routing (G2) for one web recipient (#3687), by the rules Apify's
 * consent applies (`routingGate`, `packages/common/src/apify/consent.ts`):
 * nothing leaves for a recipient from a conversation that has shown it a
 * provider folder the policy does not let it receive. A recipient no rule
 * restricts is admitted; one whose exposure cannot be judged here is refused,
 * since an unknown never becomes clean.
 */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { exposureConflicts, providerDeniedFolders, unsupportedProviderSelectors, type ProviderExposure } from "../brain/governance-policy.js";
import type { WebCallRefusal } from "./broker.js";

export function webRoutingRefusal(policy: Pick<EffectiveGovernancePolicy, "providers">, typeFolders: Readonly<Record<string, readonly string[]>> | undefined,
  exposures: readonly ProviderExposure[] | undefined, recipient: string): WebCallRefusal | null {
  const restricting = policy.providers.filter(rule => !rule.allow.includes(recipient));
  if (!restricting.length) return null;
  const selectsTypes = restricting.some(rule => rule.types?.length);
  // A selector no folder mask can express cannot be checked against exposures either.
  if (!exposures || unsupportedProviderSelectors({ providers: restricting }).length || (selectsTypes && !typeFolders)) {
    return { code: "policy_denied", message: `The provider policy restricts folders for ${recipient}, and this conversation's exposure to them is unknown here, so nothing was sent to it.` };
  }
  const denied = providerDeniedFolders(policy, typeFolders ?? {}, recipient);
  if (exposureConflicts(exposures, denied).length) {
    return { code: "policy_denied", message: `This conversation has shown folders the provider policy does not allow ${recipient} to receive, so nothing was sent to it. Start a new conversation for this web work, or use another provider.` };
  }
  return null;
}
