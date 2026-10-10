/** Environment chokepoint for the trusted worker bootstrap's internal transport. */
import { readEnvVar, type EnvVarSpec } from "./env-core.js";

export const ENV_VARS: readonly EnvVarSpec[] = [{
  name: "BRAIN_WORKER_LAUNCH",
  description: "Internal server-to-bootstrap launch payload. The launcher supplies it in a cleared environment; it is not operator configuration or a gate override.",
  required: "trusted worker bootstrap only",
}];

export function workerLaunchPayload(): string | undefined {
  return readEnvVar("BRAIN_WORKER_LAUNCH");
}
