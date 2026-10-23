/**
 * Provider keys withheld from agent workers (#1666).
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/provider-unavailable`, with no
 * compatibility promise (docs/decisions/public-export-boundary.md).
 *
 * A governed or strict turn worker receives no provider key its own inference
 * does not need. Its launcher names the keys it held back, never their values,
 * in `BRAIN_WITHHELD_KEYS`. A `brain` command that needs one of them says so
 * with a notice that ends in a fixed token, and degrades where it can. The
 * server reads that token from the tool's output and records a
 * `provider_unavailable` governance event, so the token's grammar is a contract
 * between the CLI and the server (docs/integration-contract/cli.md).
 */
import { readEnvVar } from "./env-core.js";

/** Comma-separated names of the provider keys the host withheld from this worker. Names only. */
export const WITHHELD_KEYS_ENV = "BRAIN_WITHHELD_KEYS";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MODE = /^[a-z][a-z_]{0,99}$/;
const TOKEN = /\[provider_unavailable provider=([A-Za-z0-9][A-Za-z0-9._:-]{0,99}) capability=([a-z][a-z_]{0,99}) key=([A-Za-z_][A-Za-z0-9_]{0,199}) degraded_to=([a-z][a-z_]{0,99})\]/g;

/** One provider a command needed but could not reach without its withheld key. */
export interface ProviderUnavailable {
  /** The configured provider, as the brain names it (`gemini`, `anthropic-haiku`, `jev`). */
  provider: string;
  /** What the command needed it for: `embeddings`, `completions`, `reranking` or `image`. */
  capability: string;
  /** The environment variable the host withheld. */
  key: string;
  /** The fallback the command used instead, such as `keyword_search`, or null when it refused. */
  degradedTo: string | null;
}

/** The withheld key names, parsed from `BRAIN_WITHHELD_KEYS`. Malformed entries are ignored. */
export function withheldKeys(env?: NodeJS.ProcessEnv): string[] {
  return (readEnvVar(WITHHELD_KEYS_ENV, env) ?? "").split(",").map(name => name.trim()).filter(name => NAME.test(name));
}

/**
 * Whether the host withheld `key` from this process: it is named in
 * `BRAIN_WITHHELD_KEYS` and still unset here. A key the user never set is not
 * withheld; the command keeps its ordinary keyless behaviour.
 */
export function isWithheldKey(key: string, env?: NodeJS.ProcessEnv): boolean {
  return !readEnvVar(key, env) && withheldKeys(env).includes(key);
}

/**
 * The sentence a command prints for a withheld provider, ending in the token
 * the server parses. `consequence` says what the command did instead.
 */
export function providerUnavailableNotice(unavailable: ProviderUnavailable, consequence?: string): string {
  const { provider, capability, key, degradedTo } = unavailable;
  if (!PROVIDER.test(provider) || !MODE.test(capability) || !NAME.test(key) || (degradedTo !== null && !MODE.test(degradedTo))) {
    throw new Error("provider_unavailable notice fields must be plain identifiers");
  }
  return `${provider} ${capability} unavailable: the host withholds ${key} from agent workers`
    + `${consequence ? `; ${consequence}` : ""} [provider_unavailable provider=${provider} capability=${capability} key=${key}`
    + ` degraded_to=${degradedTo ?? "none"}]`;
}

/** Every distinct notice token in `text`, in order of first appearance. */
export function parseProviderUnavailable(text: string): ProviderUnavailable[] {
  const found = new Map<string, ProviderUnavailable>();
  for (const [token, provider, capability, key, mode] of text.matchAll(TOKEN)) {
    if (!found.has(token)) found.set(token, { provider: provider!, capability: capability!, key: key!, degradedTo: mode === "none" ? null : mode! });
  }
  return [...found.values()];
}

/**
 * A provider's own missing-key error: the notice when the host withheld the
 * key from this worker, otherwise the provider's ordinary message. For a
 * provider a command calls directly, outside the registry's degradation.
 */
export function missingKeyMessage(key: string, provider: string, capability: string, ordinary: string): string {
  return isWithheldKey(key) && PROVIDER.test(provider) && MODE.test(capability) && NAME.test(key)
    ? providerUnavailableNotice({ provider, capability, key, degradedTo: null }) : ordinary;
}
