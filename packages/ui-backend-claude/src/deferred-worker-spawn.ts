/** Adapt asynchronous native preparation to the SDK's synchronous process interface. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export function deferredWorkerSpawn(start: (signal: AbortSignal) => Promise<{ process: SpawnedProcess; settled: Promise<void> }>,
  signals: readonly AbortSignal[]) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...signals]);
  // Pipe backpressure bounds pre-start buffering for a cooperative SDK writer;
  // these are streams, not a durable queue or a second request protocol.
  const stdin = new PassThrough({ highWaterMark: 64 * 1024 });
  const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  const events = new EventEmitter();
  let child: SpawnedProcess | undefined;
  let killed = false, ended = false, exitCode: number | null = null, signalCode: NodeJS.Signals | null = null;
  const finish = (code: number | null, reason: NodeJS.Signals | null) => {
    if (ended) return;
    ended = true; exitCode = code; signalCode = reason;
    events.emit("exit", code, reason);
  };
  const fail = (error: unknown) => events.emit("error", error instanceof Error ? error : new Error(String(error)));
  const kill = (reason: NodeJS.Signals = "SIGTERM") => {
    if (ended) return false;
    killed = true; signalCode = reason;
    const alreadyAborted = signal.aborted;
    controller.abort(new Error("Worker preparation was cancelled."));
    if (alreadyAborted) child?.kill(reason);
    return true;
  };
  const abort = () => { killed = true; signalCode ??= "SIGKILL"; child?.kill(signalCode); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Actual stream failures are reported through the SDK's process error event.
  stdin.on("error", fail); stdout.on("error", fail);
  const settled = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    const started = await start(signal);
    child = started.process;
    child.on("error", fail);
    child.on("exit", finish);
    if (signal.aborted) abort();
    // Even a cancelled late result is owned until its native resources settle.
    child.stdin.on("error", fail); child.stdout.on("error", fail);
    stdin.pipe(child.stdin); child.stdout.pipe(stdout);
    try { await started.settled; }
    finally {
      child.off("error", fail); child.off("exit", finish);
      finish(child.exitCode, child.signalCode ?? signalCode);
    }
  }).catch(error => {
    if (!signal.aborted) fail(error);
    finish(signal.aborted ? null : 1, signal.aborted ? signalCode ?? "SIGKILL" : null);
    throw error;
  }).finally(() => {
    signal.removeEventListener("abort", abort);
    stdin.unpipe(); stdin.destroy();
    // Let the real source drain its final bytes before the proxy ends.
    if (!child && !stdout.writableEnded) stdout.end();
  });
  // The owner awaits settled; the SDK observes the same failure through events.
  void settled.catch(() => {});
  const process: SpawnedProcess = { stdin, stdout, kill,
    get killed() { return killed; }, get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    on: events.on.bind(events), once: events.once.bind(events), off: events.off.bind(events) };
  return { process, settled };
}
