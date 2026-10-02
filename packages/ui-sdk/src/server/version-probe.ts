import {
  execWrapperSpawnOptions,
  killWrapped,
  wrapCommand,
  type ExecWrapperConfig,
} from "./exec-wrapper.js";

/** Both boot probes have the same deadline, excluding bounded cleanup. */
export const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Extra settlement budget; helper cancellation expires before this does. */
const CLEANUP_MS = 250;
const HELPER_TIMEOUT_MS = 200;

export interface VersionProbeOptions {
  /** Cancel an invocation-time check with its request, using the same bounded cleanup. */
  signal?: AbortSignal;
  cwd: string;
  env: Record<string, string | undefined>;
  exec: ExecWrapperConfig;
}
export interface VersionProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Signalling failures or cleanup that could not be confirmed within its budget. */
  cleanupWarnings: string[];
}

/** Run only a version command, with settlement independent of exit, pipe EOF and the killer. */
export async function probeVersionCommand(argv: readonly string[], options: VersionProbeOptions): Promise<VersionProbeResult> {
  options.signal?.throwIfAborted();
  const proc = Bun.spawn(wrapCommand(argv, options.exec.wrapper), {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...execWrapperSpawnOptions(options.exec.wrapper),
  });
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const output = ["", ""];
  const eof = [false, false];
  let exited = false;
  let cancelled = false;
  const reads = readers.map(async (reader, index) => {
    const decoder = new TextDecoder();
    try {
      while (!cancelled) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!cancelled) eof[index] = true;
          output[index] += decoder.decode();
          return;
        }
        output[index] += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  });
  const exit = proc.exited.then((code) => {
    exited = true;
    return code;
  });
  type Outcome = { timedOut: boolean; error?: unknown };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), VERSION_PROBE_TIMEOUT_MS);
  });
  const complete = Promise.all([...reads, exit]).then(
    (): Outcome => ({ timedOut: false }),
    (error: unknown): Outcome => ({ timedOut: false, error })
  );
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<Outcome>(resolve => {
    if (!options.signal) return;
    onAbort = () => resolve({ timedOut: false, error: options.signal!.reason || new Error("Version probe aborted") });
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
  const outcome = await Promise.race([complete, deadline, aborted]);
  if (onAbort) options.signal!.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  const cleanupWarnings: string[] = [];
  // Sweep wrapped groups even after a clean exit: descendants may have closed
  // their pipes without exiting. At a deadline this starts BEFORE waiting for exit.
  if (outcome.timedOut || outcome.error || options.exec.wrapper) {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const signalled = new Promise<void>((resolve) => {
      try {
        killWrapped(proc, options.exec, "SIGKILL", message => cleanupWarnings.push(message), {
          helperTimeoutMs: HELPER_TIMEOUT_MS,
          onComplete: resolve,
        });
      } catch (error) {
        cleanupWarnings.push(`Probe cancellation failed: ${String(error)}`);
        resolve();
      }
    });
    await Promise.race([
      Promise.all([signalled, ...reads.map(read => read.catch(() => {})), exit.catch(() => {})]),
      new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, CLEANUP_MS); }),
    ]);
    clearTimeout(cleanupTimer);
    if (!exited || !eof.every(Boolean)) {
      cleanupWarnings.push("Probe cleanup unconfirmed after 250 ms; a process or inherited output pipe may still be running. Giving up waiting.");
    }
  }
  // Cancelling reads closes this probe's pipe handles even when a descendant
  // retains its ends. Never await cancellation or an unkillable child's exit.
  cancelled = true;
  for (const reader of readers) {
    try { void reader.cancel().catch(() => {}); } catch { /* Already released after EOF. */ }
  }
  proc.unref();
  if (outcome.error) {
    if (cleanupWarnings.length) throw new Error(`${String(outcome.error)}; ${cleanupWarnings.join("; ")}`, { cause: outcome.error });
    throw outcome.error;
  }
  return {
    stdout: output[0]!,
    stderr: output[1]!,
    exitCode: proc.exitCode,
    timedOut: outcome.timedOut,
    cleanupWarnings,
  };
}
