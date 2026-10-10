/** Environment chokepoint for the trusted worker bootstrap's internal transport. */
import { readEnvVar } from "./env-core.js";
export { ENV_VARS } from "./env-vars.js";

export function workerLaunchPayload(): string | undefined {
  return readEnvVar("BRAIN_WORKER_LAUNCH");
}
