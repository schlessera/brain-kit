import { readFileSync, readdirSync } from "node:fs";

type Worker = Pick<Bun.Subprocess, "pid" | "kill" | "exitCode" | "signalCode">;
type Identity = { pid: number; start: string; parent: number; state: string };
type Stop = { identity?: Identity; stopping?: Promise<void>; failure?: Error };
const workers = new WeakMap<Worker, Stop>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH";
const exited = (worker: Worker) => worker.exitCode !== null || worker.signalCode !== null;

function identity(pid: number, task?: string): Identity | undefined {
  try {
    const raw = readFileSync(task ? `/proc/${pid}/task/${task}/stat` : `/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? "")) throw Error("Invalid maintenance process identity");
    return { pid, start: fields[19]!, parent: Number(fields[1]), state: fields[0]! };
  } catch (error) { if (missing(error)) return; throw error; }
}
function unconfirmed(error: unknown): Error {
  return Object.assign(new Error("Maintenance worker cleanup unconfirmed", { cause: error }), { cleanupUnconfirmed: true });
}

/** Bind the original kernel identity immediately after spawn, before handing out kill(). */
export function registerWorker(worker: Worker): void {
  if (workers.has(worker)) return;
  const stop: Stop = {};
  workers.set(worker, stop);
  try { if (!exited(worker)) stop.identity = identity(worker.pid); }
  catch (error) { stop.failure = unconfirmed(error); }
}
function current(worker: Worker, stop: Stop): Identity | undefined {
  if (exited(worker) || !stop.identity) return;
  const now = identity(worker.pid);
  return now?.pid === stop.identity.pid && now.start === stop.identity.start ? now : undefined;
}
function tasks(pid: number): string[] {
  try { return readdirSync(`/proc/${pid}/task`).filter(name => /^\d+$/.test(name)).sort(); }
  catch (error) { if (missing(error)) return []; throw error; }
}
function stopped(pid: number): boolean {
  const before = tasks(pid);
  if (!before.length) return false;
  if (!before.every(task => { const state = identity(pid, task)?.state; return state !== undefined && ["T", "t", "Z", "X"].includes(state); })) return false;
  return before.join() === tasks(pid).join();
}
function children(pid: number): Identity[] {
  const found = new Set<number>();
  try {
    for (const task of tasks(pid)) {
      for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) found.add(Number(child));
    }
  } catch (error) {
    if (!missing(error)) throw error;
    // CONFIG_PROC_CHILDREN is optional. The stopped outer cannot reap or fork.
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try { if (identity(Number(name))?.parent === pid) found.add(Number(name)); }
      catch (error) { if (!missing(error)) throw error; }
    }
  }
  return [...found].flatMap(child => { const id = identity(child); return id?.parent === pid ? [id] : []; });
}
function killChildren(worker: Worker, stop: Stop): boolean {
  let reached = false;
  for (const child of children(worker.pid)) {
    if (!current(worker, stop)) return reached;
    const now = identity(child.pid);
    if (now?.start !== child.start || now.parent !== worker.pid) continue;
    try { process.kill(child.pid, "SIGKILL"); reached = true; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return reached;
}

/**
 * Freeze every thread before the children snapshot, so clone cannot cross it.
 * Keep init-first cancellation and let bwrap's monitor report its normal exit.
 * All errors are retained for the owner; no detached rejection or early release.
 */
export function killWorker(worker: Worker, signal: NodeJS.Signals = "SIGKILL"): void {
  registerWorker(worker);
  const stop = workers.get(worker)!;
  if (stop.stopping || stop.failure) return;
  if (signal !== "SIGKILL") {
    try { if (current(worker, stop) && !killChildren(worker, stop) && current(worker, stop)) worker.kill(signal); }
    catch (error) { stop.failure = unconfirmed(error); }
    return;
  }
  stop.stopping = (async () => {
    let frozen = false;
    try {
      if (!current(worker, stop)) return;
      worker.kill("SIGSTOP");
      frozen = true;
      const deadline = performance.now() + 1000;
      // Always yield: observers and concurrent cancellation callers keep running.
      for (;;) {
        await Bun.sleep(1);
        if (!current(worker, stop)) return;
        if (stopped(worker.pid)) break;
        if (performance.now() >= deadline) throw Error("Maintenance worker stop deadline");
      }
      const reached = killChildren(worker, stop);
      if (current(worker, stop)) worker.kill(reached ? "SIGCONT" : signal);
      frozen = false;
    } catch (error) {
      stop.failure = unconfirmed(error);
      // Best effort only: this path never certifies cleanup or releases ownership.
      try { if (current(worker, stop) && !killChildren(worker, stop)) worker.kill(signal); }
      catch { /* The original unconfirmed failure stays with the owner. */ }
    } finally {
      if (frozen) {
        try { if (current(worker, stop)) worker.kill("SIGCONT"); }
        catch (error) { stop.failure ??= unconfirmed(error); }
      }
    }
  })();
}

/** Await the shared request before an owner can release admission or staging. */
export async function workerStopCompletion(worker: Worker): Promise<void> {
  const stop = workers.get(worker);
  await stop?.stopping;
  if (stop?.failure) throw stop.failure;
}
