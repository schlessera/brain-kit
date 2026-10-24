/**
 * The worker side of the host's provider relay (#1673).
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/provider-relay`, with no compatibility
 * promise (docs/decisions/public-export-boundary.md). The environment variable
 * and the request headers are the contract between the CLI and the relay
 * (docs/integration-contract/cli.md).
 *
 * A worker that holds no provider key reaches its provider through a Unix
 * socket the server owns. The CLI sends the provider's own native request
 * there, unchanged, and names which first-party provider, which key variable
 * and which origin it meant. The relay decides whether that key may go to that
 * origin, adds the key on the host, meters the request and refuses it once a
 * budget is blocked. The worker never sees the key.
 */
import { readEnvVar } from "./env-core.js";
import { INFERENCE_RELAY_PLACEHOLDER, isWithheldKey } from "./provider-unavailable.js";

/** Absolute path of the host's provider relay socket, set by the worker launcher. */
export const PROVIDER_RELAY_SOCKET_ENV = "BRAIN_PROVIDER_RELAY_SOCKET";
/** Which first-party request family the CLI sent: `gemini`, `anthropic` or `openai`. */
export const PROVIDER_RELAY_FAMILY_HEADER = "x-brain-provider";
/** The environment variable whose host value the request needs. A name, never a value. */
export const PROVIDER_RELAY_KEY_HEADER = "x-brain-provider-key";
/** The origin the provider would have called without the relay. */
export const PROVIDER_RELAY_ORIGIN_HEADER = "x-brain-provider-origin";
/** What a relayed provider holds where its key would be. Never a secret. */
export const PROVIDER_RELAY_PLACEHOLDER = "brain-provider-relay-placeholder";

export type ProviderRelayFamily = "gemini" | "anthropic" | "openai";

/** Credential headers the CLI never sends to the relay, whatever a provider SDK set. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie", "proxy-authorization"];

/**
 * The value of a provider key this process may send itself, or undefined. The
 * inference relay's placeholder is not a key: sending it only fails
 * authentication.
 */
export function providerCredential(key: string, env?: NodeJS.ProcessEnv): string | undefined {
  const value = readEnvVar(key, env);
  return value && value !== INFERENCE_RELAY_PLACEHOLDER ? value : undefined;
}

/** The relay socket this process was given, or undefined outside a relayed worker. */
export function providerRelaySocket(env?: NodeJS.ProcessEnv): string | undefined {
  const value = readEnvVar(PROVIDER_RELAY_SOCKET_ENV, env)?.trim();
  return value && value.startsWith("/") ? value : undefined;
}

/**
 * Whether a provider reading `key` goes through the relay: this process has a
 * relay socket, and the host withheld `key`, which it names only when it holds
 * a value. A key the host never had keeps the ordinary keyless behaviour; a key
 * an operator admitted into the worker is used as before.
 */
export function relayedKey(key: string, env?: NodeJS.ProcessEnv): boolean {
  return providerRelaySocket(env) !== undefined && isWithheldKey(key, env);
}

/**
 * A `fetch` that sends each request to the host relay instead of the network,
 * or undefined when `key` is not relayed. The request keeps its method, path,
 * query, body and content headers; every credential header is dropped, and the
 * family, key name and original origin travel as headers. Redirects are never
 * followed.
 */
export function providerRelayFetch(family: ProviderRelayFamily, key: string, env?: NodeJS.ProcessEnv): typeof fetch | undefined {
  const socket = providerRelaySocket(env);
  if (socket === undefined || !isWithheldKey(key, env)) return undefined;
  const relayed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    headers.set(PROVIDER_RELAY_FAMILY_HEADER, family);
    headers.set(PROVIDER_RELAY_KEY_HEADER, key);
    headers.set(PROVIDER_RELAY_ORIGIN_HEADER, target.origin);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    return fetch(`http://localhost${target.pathname}${target.search}`, {
      method: request.method, headers, signal: request.signal, redirect: "manual",
      ...(body ? { body } : {}), unix: socket,
    } as RequestInit);
  };
  return relayed as typeof fetch;
}
