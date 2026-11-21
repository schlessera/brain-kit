import type { StartTurnRequest } from "./backend.js";

/**
 * Best-effort diagnostics must not change a turn's work or resource ownership.
 * @experimental Backend toolkit; timing callbacks supply no authority.
 */
export function safeStartupTiming(timing: StartTurnRequest["startupTiming"]): StartTurnRequest["startupTiming"] {
  if (!timing) return undefined;
  const observe = (operation: () => unknown) => { try { operation(); } catch { /* Missing observability never fails the observed turn. */ } };
  return {
    start(name) {
      try { const end = timing.start(name); return () => observe(end); }
      catch { return () => {}; }
    },
    worker: (name, durationMs) => observe(() => timing.worker(name, durationMs)),
    missing: name => observe(() => timing.missing(name)),
    received: () => observe(() => timing.received()),
  };
}
