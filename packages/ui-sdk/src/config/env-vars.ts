/** Data-only environment descriptors, safe for the SDK's browser-facing root. */
export const ENV_VARS = [{
  name: "BRAIN_UI_MAINTENANCE_TEMP_BYTES",
  description: "Per-maintenance-command temporary-write allowance in bytes, covering its private /tmp, scratch and XDG directories. Positive page-aligned integer. Separate from agent turn temp, runtime state and output staging; overflow is ENOSPC.",
  default: "268435456",
  required: false,
}, {
  name: "BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES",
  description: "Separate aggregate maintenance temporary-write budget, shared atomically by server and cron processes. Positive page-aligned integer covering at least one command allowance. Busy admission refuses with worker_state_busy before execution. Not derived from agent session concurrency.",
  default: "268435456",
  required: false,
}, {
  name: "BRAIN_WORKER_LAUNCH",
  description: "Internal server-to-bootstrap launch payload. The launcher supplies it in a cleared environment; it is not operator configuration or a gate override.",
  required: "trusted worker bootstrap only",
}, {
  name: "BRAIN_UI_WORKER_LIMITS",
  description: "Resource limits for each agent worker, as comma-separated name=value pairs over the defaults: processes, data, file_size and open_files (rlimits), memory, pids and cpu (the per-worker cgroup, when the host delegates one), and cgroup=on|off. Sizes take KiB, MiB, GiB or TiB; `unlimited` turns one limit off. A malformed entry refuses agent turns and names the entry. See docs/hosting/agent-workers.md#resource-limits.",
  default: "processes=4096, data and memory=half the server's memory (physical, or a lower cgroup cap above it), file_size=16GiB, open_files=65536, pids=4096, cpu=all CPUs but one, cgroup=on",
  required: false,
}, {
  name: "BRAIN_MAINTENANCE_GIT",
  description: "Internal path to the server-built immutable Git adapter configuration, supplied by a maintenance launch; not an operator input.",
  required: "trusted maintenance Git adapter only",
}, {
  name: "BRAIN_UI_OUTPUT_STAGING_BYTES", description: "Immutable starting inputs and private worker outputs share a separate bounded tmpfs; positive page-aligned bytes. Writes past it fail with ENOSPC.", default: "268435456 (256 MiB)", required: false,
}, {
  name: "BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES", description: "Aggregate output-staging capacity in the shared worker admission ledger; positive page-aligned bytes, at least one allowance. Busy admission refuses with worker_state_busy and Retry.", default: "BRAIN_UI_OUTPUT_STAGING_BYTES × MAX_CONCURRENT_SESSIONS", required: false,
}, {
  name: "MAX_CONCURRENT_SESSIONS", description: "Concurrent-session cap used to derive the default aggregate output-staging budget.", default: "3", required: false,
}] as const;
