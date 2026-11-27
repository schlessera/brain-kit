/**
 * Which variables reach a worker (#4827): the `--setenv` arguments of its
 * sandbox command, computed from the launch's environment alone. It touches
 * no file and spawns nothing, so it runs without bubblewrap. A leaf: worker
 * paths and constants arrive as arguments.
 */
import { INFERENCE_RELAY_PLACEHOLDER, WITHHELD_KEYS_ENV } from "@schlessera/brain-common/internal/provider-unavailable";
import { PROVIDER_RELAY_SOCKET_ENV } from "@schlessera/brain-common/internal/provider-relay";
import { HOST_GIT_CREDENTIAL_ENV, WORKER_PROVIDER_CREDENTIAL_ENV, workerProviderCredentials } from "./subprocess-env.js";
import { hostProviderCredentialNames } from "../config/env.js";

/** The variable naming the module GitHub relay's socket inside the worker. */
export const MODULE_GITHUB_SOCKET_ENV = "BRAIN_MODULE_GITHUB_SOCKET";

export interface WorkerEnvironmentInput {
  /** The launch's environment; its variables reach the worker in this order. */
  readonly env: Readonly<Record<string, string>>;
  /** The provider keys a governed or strict turn worker keeps. */
  readonly credentialEnv?: readonly string[];
  /** A governed or strict turn worker, which holds no provider credential its own inference does not need (#1666). */
  readonly turnProfile: boolean;
  /** A transport worker, the only one that keeps host Git credentials. */
  readonly transport: boolean;
  /** The provider relay's socket inside the worker, when a relay is mounted. */
  readonly providerRelaySocket?: string;
  /** Operator-listed custom keys the provider relay holds. */
  readonly relayedKeyNames: readonly string[];
  /** The turn's data tree inside the worker, and the configuration root beside it. */
  readonly dataTree?: { readonly root: string; readonly configRoot: string };
  /** The module GitHub relay's socket inside the worker, when one is mounted. */
  readonly githubSocket?: string;
}

/** The worker's `--setenv` arguments, in the order its sandbox command carries them. */
export function workerEnvironmentArgs(input: WorkerEnvironmentInput): string[] {
  const args: string[] = [];
  const credentials = input.turnProfile ? workerProviderCredentials(input.env, input.credentialEnv ?? []) : undefined;
  for (const [key, value] of Object.entries(input.env)) {
    if (credentials && (key === WITHHELD_KEYS_ENV || WORKER_PROVIDER_CREDENTIAL_ENV.includes(key) && !(input.credentialEnv ?? []).includes(key))) continue;
    // Only the server's own relay may name the socket: never a value carried from the host environment.
    if (key === PROVIDER_RELAY_SOCKET_ENV) continue;
    if (input.transport || !HOST_GIT_CREDENTIAL_ENV.includes(key)) args.push("--setenv", key, value);
  }
  // Names only: what the host or this launch had that the worker does not.
  // A relay placeholder is not a key: the CLI reaches that key through the
  // provider relay instead of sending the placeholder (#1673).
  const placeholders = credentials ? credentials.kept.filter(name => input.env[name] === INFERENCE_RELAY_PLACEHOLDER) : [];
  const withheld = credentials && [...new Set([...credentials.withheld,
    ...hostProviderCredentialNames(WORKER_PROVIDER_CREDENTIAL_ENV).filter(name => !credentials.kept.includes(name) || placeholders.includes(name)),
    // An operator-listed custom key the relay holds, unless the worker was given it.
    ...input.relayedKeyNames.filter(name => !input.env[name])])].sort();
  if (input.dataTree) args.push("--setenv", "BRAIN_ROOT", input.dataTree.root, "--setenv", "BRAIN_WORKER_DATA_ROOT", input.dataTree.root,
    "--setenv", "BRAIN_WORKER_CONFIG_ROOT", input.dataTree.configRoot);
  if (withheld?.length) args.push("--setenv", WITHHELD_KEYS_ENV, withheld.join(","));
  if (input.providerRelaySocket) args.push("--setenv", PROVIDER_RELAY_SOCKET_ENV, input.providerRelaySocket);
  if (input.githubSocket) args.push("--setenv", MODULE_GITHUB_SOCKET_ENV, input.githubSocket);
  return args;
}
