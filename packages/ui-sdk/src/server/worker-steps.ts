/**
 * One implementation, two ways to wait (#2416). A worker check written as a
 * generator yields each wait (a subprocess, a sleep, a broker request) as a
 * step with a synchronous and an asynchronous form. The synchronous driver
 * keeps the old blocking contract for callers that cannot await; the
 * asynchronous driver lets the server's event loop keep answering while the
 * same check, in the same order, waits on a worker that a loaded host starts
 * slowly.
 */

/** A wait with both forms; each driver runs exactly one of them. */
export interface WorkerStep<T = unknown> { readonly sync: () => T; readonly async: () => Promise<T> }
export type WorkerSteps<T> = Generator<WorkerStep, T, unknown>;

/** Yield one wait and receive its result, typed. */
export function* workerStep<T>(sync: () => T, async: () => Promise<T>): WorkerSteps<T> {
  return (yield { sync, async }) as T;
}

/** Descriptor stdio and an optional deadline, as both spawn forms accept them. */
export interface WorkerStepSpawnOptions {
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stdin: number;
  readonly stdout: number;
  readonly stderr: number;
  readonly timeout?: number;
}

/**
 * Run a command to its end. `exitCode` is null when a signal ended it,
 * including the deadline's SIGTERM, as `Bun.spawnSync` reports it.
 */
export function workerStepSpawn(command: string[], options: WorkerStepSpawnOptions): WorkerSteps<{ exitCode: number | null }> {
  return workerStep(() => ({ exitCode: Bun.spawnSync(command, options).exitCode }), async () => {
    const child = Bun.spawn(command, options);
    await child.exited;
    return { exitCode: child.exitCode };
  });
}

/** Run a short command to its end, keeping what it wrote to stderr; its stdout is discarded. */
export function workerStepRun(command: string[]): WorkerSteps<{ exitCode: number | null; stderr: string }> {
  return workerStep(() => {
    const ran = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
    return { exitCode: ran.exitCode, stderr: ran.stderr.toString() };
  }, async () => {
    const ran = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    const [stderr] = await Promise.all([new Response(ran.stderr).text(), ran.exited]);
    return { exitCode: ran.exitCode, stderr };
  });
}

export function workerStepSleep(ms: number): WorkerSteps<void> {
  return workerStep(() => { Bun.sleepSync(ms); }, () => Bun.sleep(ms));
}

/** Drive the steps, blocking the calling thread at each wait. */
export function runWorkerStepsSync<T>(steps: WorkerSteps<T>): T {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try { value = next.value.sync(); } catch (error) { next = steps.throw(error); continue; }
    next = steps.next(value);
  }
  return next.value;
}

/** Drive the steps, yielding the event loop at each wait. */
export async function runWorkerStepsAsync<T>(steps: WorkerSteps<T>): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try { value = await next.value.async(); } catch (error) { next = steps.throw(error); continue; }
    next = steps.next(value);
  }
  return next.value;
}
