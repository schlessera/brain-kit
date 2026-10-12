/** Environment chokepoint for the trusted worker bootstrap's internal transport and the worker limits. */
import { readEnvVar } from "@schlessera/brain-common/internal/env";
export { ENV_VARS } from "./env-vars.js";

export function workerLaunchPayload(): string | undefined {
  return readEnvVar("BRAIN_WORKER_LAUNCH");
}

/** The host's agent worker resource limits (#1660), parsed by `parseWorkerLimits`. */
export function workerLimitsSpec(): string | undefined {
  return readEnvVar("BRAIN_UI_WORKER_LIMITS");
}

/** Internal immutable Git adapter inputs and the worker's own explicit child environment. */
export function maintenanceGitEnvironment(): { path: string | undefined; env: NodeJS.ProcessEnv } {
  return { path: readEnvVar("BRAIN_MAINTENANCE_GIT"), env: { ...process.env } };
}
export const DYNAMIC_ENV_READS = [{ source: "maintenance Git subprocess environment",
  description: "Inherits the already-cleared maintenance worker environment at call time. This internal transport admits no additional operator configuration or host credential." }] as const;

/** Trusted host settings for output staging; callers pass these only before worker launch. */
export function outputStagingEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(["BRAIN_UI_OUTPUT_STAGING_BYTES", "BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES", "MAX_CONCURRENT_SESSIONS"]
    .map(name => [name, readEnvVar(name)]));
}
