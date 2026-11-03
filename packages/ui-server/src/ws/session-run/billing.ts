import type { BillingMode, PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendRegistry } from "../../agent/backend.js";

export type RunBilling = Awaited<ReturnType<typeof resolveRunBilling>>;

/**
 * Profile identity + billing mode for a turn's root span. When the slot has no
 * resolved profile id (a resumed session whose pin was dropped), the backend
 * runs its default profile — the backend's first roster entry — so THAT
 * profile's identity and billing are recorded, not the dead pin's. Hidden
 * profiles are included: a session pinned to a profile the user later hid
 * still runs on it and must classify as it. Never throws: an unreadable
 * roster records no billing attrs, and the rollup leaves billing unknown
 * rather than inferring it from server credentials.
 */
export async function resolveRunBilling(
  registry: BackendRegistry,
  backendId: string,
  profileId: string | undefined
): Promise<
  { profileId: string; model?: string; billingMode?: BillingMode; pricingRoute?: PricingRoute } | undefined
> {
  try {
    const providers = await registry.listAllProviders({ includeHidden: true });
    const resolved = profileId
      ? providers.find((provider) => provider.id === profileId)
      : providers.find((provider) => provider.backendId === backendId);
    if (!resolved) return undefined;
    return {
      profileId: resolved.id,
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.billingMode ? { billingMode: resolved.billingMode } : {}),
      ...(resolved.pricingRoute ? { pricingRoute: resolved.pricingRoute } : {}),
    };
  } catch {
    return undefined;
  }
}
