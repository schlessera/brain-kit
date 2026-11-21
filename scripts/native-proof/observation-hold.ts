import { get } from "node:http";
/** One confirmed physical freeze may contain several serialized observations. */
export function observationHold(worker: { freeze(): void; resume(): void; kill(signal: NodeJS.Signals): void }, clock: () => number = () => performance.timeOrigin + performance.now()) {
  let depth = 0, started = 0, failed = false, shared = false;
  let last = { frozenMs: 0, sharedHold: false, startedAt: 0, endedAt: 0 };
  const waiters = new Set<() => void>();
  return {
    before() {
      if (depth++ === 0) { worker.freeze(); started = clock(); failed = false; shared = false; }
      else shared = true;
    },
    after(completed: boolean) {
      failed ||= !completed;
      if (--depth > 0) return;
      const endedAt = clock();
      last = { frozenMs: endedAt - started, sharedHold: shared, startedAt: started, endedAt };
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

/** No client idle deadline; the proof's explicit abort watchdog owns this request. */
export function observationMatrixRequest(url: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })));
    });
    request.setTimeout(0);
    request.once("error", reject);
  });
}
