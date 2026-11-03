/** Environment chokepoint for the trusted worker bootstrap's internal transport and the worker limits. */
import { readEnvVar } from "@schlessera/brain-common/internal/env";
export { ENV_VARS } from "./env-vars.js";

export function workerLaunchPayload(): string | undefined {
  return readEnvVar("BRAIN_WORKER_LAUNCH");
}

/** Optional host-owned cross-UID broker helper, never read inside a worker. */
export function workerIdentityHelperInput(): string | undefined {
  return readEnvVar("BRAIN_UI_WORKER_IDENTITY_HELPER");
}

/** The host's agent worker resource limits (#1660), parsed by `parseWorkerLimits`. */
export function workerLimitsSpec(): string | undefined {
  return readEnvVar("BRAIN_UI_WORKER_LIMITS");
}

/** Internal immutable Git adapter inputs and the worker's own explicit child environment. */
export function maintenanceGitEnvironment(): { path: string | undefined; env: NodeJS.ProcessEnv } {
  return { path: readEnvVar("BRAIN_MAINTENANCE_GIT"), env: { ...process.env } };
}
/** Inside the trusted egress bootstrap, after the launcher's complete environment replacement. */
export function workerEgressEnvironment(): NodeJS.ProcessEnv { return { ...process.env }; }
/**
 * The provider credentials the server's own environment sets, by name (#1666).
 * Values are never returned: a turn worker is told only which keys it lacks.
 */
export function hostProviderCredentialNames(names: readonly string[]): string[] {
  return names.filter(name => Boolean(readEnvVar(name)));
}
/**
 * One provider key the server holds, read by the CLI provider relay at
 * dispatch (#1673). The value is placed on the upstream request only; it never
 * enters a worker, a log or a record.
 */
export function hostProviderCredential(name: string): string | undefined {
  return readEnvVar(name);
}
/**
 * One external compute credential the operator bound for hosted jobs
 * (BRAIN_UI_COMPUTE_KEYS, #3108), read when the host admits or advances a
 * job. The value goes to the provider call only; it never enters a worker,
 * a job record, a tool result or an approval card.
 */
export function hostComputeCredential(name: string): string | undefined {
  return readEnvVar(name);
}
export const DYNAMIC_ENV_READS = [{ source: "external compute credential",
  description: "The value of a compute credential variable the operator bound in BRAIN_UI_COMPUTE_KEYS (or the default variable of a provider listed there), read on the host when a hosted compute job is admitted or advanced. Passed to the provider call only, never to a worker, record or result." },
{ source: "provider credential presence",
  description: "Whether each provider credential in the subprocess descriptor is set on the server, so a governed or strict turn worker's BRAIN_WITHHELD_KEYS names the keys the host withheld. Names only; no value leaves the server." },
{ source: "provider relay credential",
  description: "The value of the provider key a relayed CLI request names, read when the CLI provider relay dispatches it: a built-in provider's own key variable, or one BRAIN_UI_CLI_PROVIDER_ORIGINS lists. Placed on the upstream request only, never returned to a worker." },
{ source: "maintenance Git subprocess environment",
  description: "Inherits the already-cleared maintenance worker environment at call time. This internal transport admits no additional operator configuration or host credential." },
{ source: "egress worker subprocess environment", description: "The trusted loopback bootstrap preserves only the worker environment already cleared and selected by the launcher, replacing proxy routing before its child starts. It admits no host environment or new operator setting." }] as const;

/** Trusted host settings for output staging; callers pass these only before worker launch. */
export function outputStagingEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(["BRAIN_UI_OUTPUT_STAGING_BYTES", "BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES", "MAX_CONCURRENT_SESSIONS"]
    .map(name => [name, readEnvVar(name)]));
}

/** Trusted host edge; never the environment a maintenance command supplies. */
export function maintenanceTempEnvironment(): Record<string, string | undefined> {
  return { BRAIN_UI_MAINTENANCE_TEMP_BYTES: readEnvVar("BRAIN_UI_MAINTENANCE_TEMP_BYTES"),
    BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES: readEnvVar("BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES") };
}

/** Internal fixed maintenance-output target, supplied only by the launcher. */
export function maintenanceOutputRoot(): string | undefined { return readEnvVar("BRAIN_ROOT"); }
