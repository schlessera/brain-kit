import type { StartTurnRequest } from "./backend.js";

/** Internal diagnostic boundary: never wait for a sink or leave its rejection unhandled. */
export function observeDiagnostic(operation: () => unknown): void {
  try {
    const result = operation();
    if (result !== null && (typeof result === "object" || typeof result === "function"))
      void Promise.resolve(result).catch(() => {});
  } catch { /* Missing observability never fails the observed work. */ }
}

/** Both edges of an optional diagnostic interval are independent of the observed work. */
export function diagnosticInterval(start: () => unknown): () => void {
  let end: unknown;
  observeDiagnostic(() => end = start());
  return () => observeDiagnostic(() => typeof end === "function" ? end() : undefined);
}

/**
 * Best-effort diagnostics must not change a turn's work or resource ownership.
 * @experimental Backend toolkit; timing callbacks supply no authority.
 */
export function safeStartupTiming(timing: StartTurnRequest["startupTiming"]): StartTurnRequest["startupTiming"] {
  if (!timing) return undefined;
  let mcpInit: typeof timing.mcpInit;
  observeDiagnostic(() => { mcpInit = timing.mcpInit?.bind(timing); });
  return {
    start: name => diagnosticInterval(() => timing.start(name)),
    worker: (name, durationMs) => observeDiagnostic(() => timing.worker(name, durationMs)),
    missing: (name, omitted) => observeDiagnostic(() => omitted === undefined ? timing.missing(name) : timing.missing(name, omitted)),
    ...(mcpInit ? { mcpInit: servers => observeDiagnostic(() => mcpInit?.(servers)) } : {}),
    received: () => observeDiagnostic(() => timing.received()),
  };
}
