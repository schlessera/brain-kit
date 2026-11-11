/**
 * Registered live-conversation services and how a new Start resolves one
 * (#3616). Registration is fixed at construction: "usable" means registered at
 * boot, never a probed credential, so a key that fails later surfaces through
 * the provider's own `provider_error` close and never selects another service.
 *
 * Precedence for a Start without a one-time pick:
 *   1. the saved brain-wide default, only if it is registered; a saved but
 *      unregistered default stops here with no effective service (no
 *      fall-through to the host default or the only service);
 *   2. the host default, only when nothing is saved;
 *   3. the single registered service, only when nothing is saved;
 *   4. otherwise none: a Start must name a service.
 *
 * Nothing here reads a credential, opens a provider or reads chat content.
 */

import type { LiveDefault } from "@schlessera/brain-ui-sdk/protocol";
import { assertLiveConversationProvider, type LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";

interface LiveProviderOptions {
  conversationProvider?: LiveConversationProvider;
  conversationProviders?: LiveConversationProvider[];
  defaultConversationProviderId?: string;
}

export interface LiveProviderRegistry {
  /** Registration order. */
  readonly providers: readonly LiveConversationProvider[];
  readonly hostDefault: string | null;
  get(id: string): LiveConversationProvider | undefined;
  /** Resolve the effective service from the saved default (`null` = nothing saved). */
  resolve(saved: string | null): LiveDefault;
}

/**
 * Validate and freeze the registration. Throws on both options at once,
 * duplicate ids, an invalid provider, or a host default that names no
 * registered service.
 */
export function createLiveProviderRegistry(options: LiveProviderOptions): LiveProviderRegistry {
  if (options.conversationProvider !== undefined && options.conversationProviders !== undefined) {
    throw new Error("Pass either conversationProvider or conversationProviders, not both.");
  }
  if (options.conversationProviders !== undefined && !Array.isArray(options.conversationProviders)) {
    throw new Error("conversationProviders must be an array of LiveConversationProvider.");
  }
  const providers = Object.freeze([...(options.conversationProviders ?? (options.conversationProvider ? [options.conversationProvider] : []))]);
  const byId = new Map<string, LiveConversationProvider>();
  for (const provider of providers) {
    assertLiveConversationProvider(provider);
    if (byId.has(provider.id)) throw new Error(`Duplicate live conversation provider id "${provider.id}".`);
    byId.set(provider.id, provider);
  }
  const hostDefault = options.defaultConversationProviderId ?? null;
  if (hostDefault !== null && !byId.has(hostDefault)) {
    throw new Error(`defaultConversationProviderId "${hostDefault}" is not a registered live conversation provider.`);
  }
  return {
    providers,
    hostDefault,
    get: (id) => byId.get(id),
    resolve(saved) {
      if (saved !== null) {
        const usable = byId.has(saved);
        return { saved, savedUsable: usable, effective: usable ? saved : null, source: usable ? "saved" : "none" };
      }
      if (hostDefault !== null) return { saved: null, savedUsable: false, effective: hostDefault, source: "host" };
      if (providers.length === 1) return { saved: null, savedUsable: false, effective: providers[0]!.id, source: "only" };
      return { saved: null, savedUsable: false, effective: null, source: "none" };
    },
  };
}
