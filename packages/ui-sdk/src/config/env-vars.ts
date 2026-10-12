/** Data-only environment descriptors, safe for the SDK's browser-facing root. */
export const ENV_VARS = [{
  name: "BRAIN_MAINTENANCE_GIT",
  description: "Internal path to the server-built immutable Git adapter configuration, supplied by a maintenance launch; not an operator input.",
  required: "trusted maintenance Git adapter only",
}, {
  name: "BRAIN_WORKER_LAUNCH",
  description: "Internal server-to-bootstrap launch payload. The launcher supplies it in a cleared environment; it is not operator configuration or a gate override.",
  required: "trusted worker bootstrap only",
}, {
  name: "BRAIN_UI_WORKER_LIMITS",
  description: "Resource limits for each agent worker, as comma-separated name=value pairs over the defaults: processes, data, file_size and open_files (rlimits), memory, pids and cpu (the per-worker cgroup, when the host delegates one), and cgroup=on|off. Sizes take KiB, MiB, GiB or TiB; `unlimited` turns one limit off. A malformed entry refuses agent turns and names the entry. See docs/hosting/agent-workers.md#resource-limits.",
  default: "processes=4096, data and memory=half the server's memory (physical, or a lower cgroup cap above it), file_size=16GiB, open_files=65536, pids=4096, cpu=all CPUs but one, cgroup=on",
  required: false,
}] as const;
