import type { StartTurnRequest } from "./backend.js";

/** Internal diagnostic boundary: never wait for a sink or leave its rejection unhandled. */
export function observeDiagnostic(operation: () => unknown): void {
  try {
    const result = operation();
    if (result !== null && (typeof result === "object" || typeof result === "function"))
      void Promise.resolve(result).catch(() => {});
  } catch { /* Missing observability never fails the observed work. */ }
}

/**
 * Best-effort diagnostics must not change a turn's work or resource ownership.
 * @experimental Backend toolkit; timing callbacks supply no authority.
 */
export function safeStartupTiming(timing: StartTurnRequest["startupTiming"]): StartTurnRequest["startupTiming"] {
  if (!timing) return undefined;
  return {
    start(name) {
      let end: unknown;
      observeDiagnostic(() => end = timing.start(name));
      return () => observeDiagnostic(() => typeof end === "function" ? end() : undefined);
    },
    worker: (name, durationMs) => observeDiagnostic(() => timing.worker(name, durationMs)),
    missing: name => observeDiagnostic(() => timing.missing(name)),
    received: () => observeDiagnostic(() => timing.received()),
  };
}
