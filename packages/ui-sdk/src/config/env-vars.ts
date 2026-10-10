/** Data-only environment descriptors, safe for the SDK's browser-facing root. */
export const ENV_VARS = [{
  name: "BRAIN_WORKER_LAUNCH",
  description: "Internal server-to-bootstrap launch payload. The launcher supplies it in a cleared environment; it is not operator configuration or a gate override.",
  required: "trusted worker bootstrap only",
}] as const;
