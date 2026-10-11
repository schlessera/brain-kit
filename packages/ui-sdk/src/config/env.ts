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
