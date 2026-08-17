import type { ImagesConfig } from "../module.js";
import type { ModelCapabilities, Provider, ProviderId } from "../types.js";
import { geminiProvider } from "./gemini.js";
import { openaiProvider } from "./openai.js";

export const PROVIDERS: Provider[] = [openaiProvider, geminiProvider];

export function providerFor(id: ProviderId): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown image provider: ${id}`);
  return found;
}

/**
 * Models whose provider has a key present, minus anything the config disabled.
 *
 * Availability is resolved at call time rather than at boot: the same brain runs
 * on a laptop with several keys and in a container that may have one or none,
 * and the difference should surface as "here is what I can do" rather than as a
 * failed API call.
 */
export function availableModels(cfg: ImagesConfig, env = process.env): ModelCapabilities[] {
  const disabled = new Set(cfg.disabledModels ?? []);
  return PROVIDERS.filter((p) => !!env[p.apiKeyEnv]?.trim())
    .flatMap((p) => p.models)
    .filter((m) => !disabled.has(m.id));
}

export { geminiProvider, openaiProvider };
