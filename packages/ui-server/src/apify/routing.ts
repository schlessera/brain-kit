import type { ApifyProviderRouting } from "@schlessera/brain-common/internal/apify";
import { exposureConflicts, providerDeniedFolders, unsupportedProviderSelectors } from "../brain/governance-policy.js";

/**
 * The host's provider-folder routing (G2) for Apify consent: the same rules a
 * turn's admission uses, passed into core's consent so it names no host type.
 */
export const APIFY_PROVIDER_ROUTING: ApifyProviderRouting = { unsupportedProviderSelectors, providerDeniedFolders, exposureConflicts };
