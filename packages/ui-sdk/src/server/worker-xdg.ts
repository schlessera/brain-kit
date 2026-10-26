/** Leaf policy values: safe during sandbox/maintenance/launcher initialization. */
/**
 * Per-turn XDG directories on the worker's private `/tmp` (#1703). The real
 * host home stays read-only; a backend may select a private runtime HOME.
 */
export const WORKER_XDG_HOME = "/tmp/brain-worker-home";
export const WORKER_XDG_DIRS = {
  XDG_CONFIG_HOME: `${WORKER_XDG_HOME}/config`,
  XDG_CACHE_HOME: `${WORKER_XDG_HOME}/cache`,
  XDG_DATA_HOME: `${WORKER_XDG_HOME}/data`,
} as const;
