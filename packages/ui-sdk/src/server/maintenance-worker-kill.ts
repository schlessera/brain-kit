import { closeSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";

type Worker = Pick<Bun.Subprocess, "pid" | "kill" | "exitCode" | "signalCode" | "exited">;
type Identity = { pid: number; start: string; parent: number; state: string };
type Native = { open(pid: number): number; signal(fd: number, signal: number): number };
type Stop = { identity?: Identity; api?: Native; fd?: number; registrationError?: unknown; stopping?: Promise<void>;
  closed?: Promise<void>; failure?: Error; ended?: boolean; gone?: boolean; confirmed?: boolean; signal?: NodeJS.Signals };
const workers = new WeakMap<Worker, Stop>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH";
const exited = (worker: Worker) => worker.exitCode !== null || worker.signalCode !== null;
let native: Native | null | undefined;

/** Node consumers can import the package without evaluating bun:ffi or dlopen. */
function libc(): Native | undefined {
  if (native !== undefined) return native ?? undefined;
  native = null;
  if (process.platform !== "linux" || !process.versions.bun) return;
  try {
    const { dlopen, read } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
    const api = dlopen("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });
    const errno = api.symbols.__errno_location();
    if (!errno) { api.close(); return; }
    native = {
      open(pid) {
        const fd = api.symbols.pidfd_open(pid, 0);
        const error = fd < 0 ? (read.i32(errno, 0) || -1) : 0;
        if (error) throw Object.assign(Error("Maintenance pidfd registration failed"), { errno: error });
        return fd;
      },
      signal(fd, signal) {
        const result = api.symbols.pidfd_send_signal(fd, signal, null, 0);
        return result < 0 ? (read.i32(errno, 0) || -1) : 0;
      },
    };
  } catch { /* Unavailable libc/FFI leaves cancellation explicitly unconfirmed. */ }
  return native ?? undefined;
}
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
function closeAuthority(stop: Stop): void {
  const fd = stop.fd;
  stop.fd = undefined; // Clear before close: the descriptor number can be reused immediately.
  if (fd !== undefined) closeSync(fd);
}

/** Sample and bind immediately after spawn; this is not atomic pidfd-from-spawn acquisition. */
export function registerWorker(worker: Worker): void {
  if (workers.has(worker)) return;
  const stop: Stop = {};
  workers.set(worker, stop);
  let opened: number | undefined;
  try {
    if (!exited(worker)) {
      const api = libc();
      if (!api) throw Error("Maintenance pidfd authority unavailable");
      opened = api.open(worker.pid);
      const before = identity(worker.pid);
      const error = api.signal(opened, 0);
      if (error) { if (error === 3) stop.gone = true; throw Error(`Maintenance pidfd identity check failed: ${error}`); }
      const after = identity(worker.pid);
      if (!before || before.parent !== process.pid || !after || after.parent !== process.pid || after.start !== before.start || exited(worker))
        throw Error("Maintenance pidfd launch identity changed");
      stop.identity = after; stop.api = api; stop.fd = opened; opened = undefined;
    }
  } catch (error) { stop.registrationError = error; if ((error as { errno?: number }).errno === 3) stop.gone = true; }
  finally { if (opened !== undefined) { try { closeSync(opened); } catch (error) { stop.registrationError ??= error; } } }
  // Observation errors alone cannot poison a normal, uncancelled exit.
  stop.closed = worker.exited.then(async () => {
    stop.ended = true;
    await stop.stopping;
    closeAuthority(stop);
  }, async error => {
    stop.ended = true; stop.registrationError ??= error;
    await stop.stopping;
    closeAuthority(stop);
  }).catch(error => { stop.registrationError ??= error; if (stop.signal) stop.failure ??= unconfirmed(error); });
}
function baselineKill(worker: Worker, stop: Stop, signal: NodeJS.Signals = "SIGKILL"): void {
  // Baseline only: no PID-reuse or descendant-termination guarantee without authority.
  if (!stop.ended && !stop.gone && !exited(worker)) worker.kill(signal);
}
function signalOuter(worker: Worker, stop: Stop, signal: NodeJS.Signals): boolean {
  if (stop.ended || stop.gone || exited(worker)) return false;
  if (stop.fd === undefined || !stop.api) {
    stop.failure ??= unconfirmed(stop.registrationError ?? "No stable maintenance authority");
    baselineKill(worker, stop, signal); return false;
  }
  const number: number | undefined = (constants.signals as Readonly<Record<string, number | undefined>>)[signal];
  if (number === undefined) throw Error("Unsupported maintenance signal");
  const error = stop.api.signal(stop.fd, number);
  if (!error) return true;
  if (error === 3) { stop.gone = true; return false; }
  stop.failure ??= unconfirmed(Error(`Maintenance pidfd signal failed: ${error}`));
  baselineKill(worker, stop);
  return false;
}
function outerLive(worker: Worker, stop: Stop): boolean {
  if (stop.ended || stop.gone || exited(worker) || stop.fd === undefined || !stop.api) return false;
  const error = stop.api.signal(stop.fd, 0);
  if (!error) return true;
  if (error === 3) { stop.gone = true; return false; }
  throw Error(`Maintenance pidfd liveness failed: ${error}`);
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
  if (!stop.confirmed || !stop.identity || worker.pid !== stop.identity.pid) return false;
  let reached = false;
  for (const child of children(worker.pid)) {
    const now = identity(child.pid);
    if (now?.start !== child.start || now.parent !== worker.pid || !outerLive(worker, stop)) continue;
    try { process.kill(child.pid, "SIGKILL"); reached = true; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return reached;
}

/** Freeze before enumerating, then preserve init-first monitor exit semantics. */
export function killWorker(worker: Worker, signal: NodeJS.Signals = "SIGKILL"): void {
  registerWorker(worker);
  const stop = workers.get(worker)!;
  if (stop.ended || stop.gone || exited(worker) || stop.identity && stop.identity.pid !== worker.pid) return;
  if (stop.stopping) { if (signal === "SIGKILL") stop.signal = signal; return; }
  stop.signal = signal;
  stop.stopping = (async () => {
    let frozen = false;
    try {
      if (stop.fd === undefined) { signalOuter(worker, stop, signal); return; }
      if (!signalOuter(worker, stop, "SIGSTOP")) return;
      frozen = true;
      const deadline = performance.now() + 1000;
      for (;;) {
        await Bun.sleep(1);
        if (!outerLive(worker, stop)) return;
        if (stopped(worker.pid)) break;
        if (performance.now() >= deadline) throw Error("Maintenance worker stop deadline");
      }
      stop.confirmed = true;
      const reached = killChildren(worker, stop);
      const requested = stop.signal!;
      signalOuter(worker, stop, reached ? "SIGCONT" : requested);
      if (reached || requested === "SIGKILL") frozen = false;
    } catch (error) {
      stop.failure ??= unconfirmed(error);
      // A child-observation failure cannot suppress the independent outer fallback.
      try { killChildren(worker, stop); } catch { /* Keep the first failure. */ }
      try { signalOuter(worker, stop, "SIGKILL"); } catch (error) { stop.failure ??= unconfirmed(error); }
    } finally {
      stop.confirmed = false;
      if (frozen) {
        try { signalOuter(worker, stop, "SIGCONT"); } catch (error) { stop.failure ??= unconfirmed(error); }
      }
    }
  })();
  const pending = stop.stopping;
  void pending.then(() => { if (stop.signal !== "SIGKILL" && stop.stopping === pending) stop.stopping = undefined; });
}

/** The existing owner awaits cancellation before closing input or releasing admission. */
export async function workerStopCompletion(worker: Worker): Promise<void> {
  const stop = workers.get(worker);
  await stop?.stopping;
  if (stop?.ended) await stop.closed;
  if (stop?.failure) throw stop.failure;
}
