/** One confirmed physical freeze may contain several serialized observations. */
export function observationHold(worker: { freeze(): void; resume(): void; kill(signal: NodeJS.Signals): void }, clock: () => number = performance.now.bind(performance)) {
  let depth = 0, started = 0, failed = false, shared = false;
  let last = { frozenMs: 0, sharedHold: false };
  const waiters = new Set<() => void>();
  return {
    before() {
      if (depth++ === 0) { worker.freeze(); started = clock(); failed = false; shared = false; }
      else shared = true;
    },
    after(completed: boolean) {
      failed ||= !completed;
      if (--depth > 0) return;
      last = { frozenMs: clock() - started, sharedHold: shared };
      if (failed) worker.kill("SIGKILL"); else worker.resume();
      for (const wake of waiters) wake(); waiters.clear();
    },
    idle(): Promise<void> { return depth === 0 ? Promise.resolve() : new Promise(resolve => { waiters.add(resolve); }); },
    sample: () => ({ ...last }),
  };
}
/** The matrix has its own watchdog; the server's idle timer cannot own it. */
export async function observationMatrixResponse(request: Request, server: { timeout(request: Request, seconds: number): void }, work: () => Promise<unknown>): Promise<Response> {
  server.timeout(request, 0);
  return Response.json(await work());
}
