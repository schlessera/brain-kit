/**
 * One gog process (plan §8): spawned in its own process group with exactly
 * the allow-listed environment, stdin from the host or nothing, stdout read
 * up to a cap, stderr drained and dropped, and the whole group killed on a
 * timeout, on an oversized answer and after it exits, so nothing it started
 * outlives the call.
 */
import type { GogProcessEnd } from "./errors.js";

/** Operation answers are capped at 8 MiB (plan §8). */
export const GOG_STDOUT_CAP = 8 * 1024 * 1024;

export interface GogProcessOptions {
  env: Readonly<Record<string, string>>;
  stdin: Uint8Array | null;
  timeoutMs: number;
  stdoutCap: number;
}

export interface GogProcessResult {
  end: GogProcessEnd;
  /** The answer, only when the process exited (any code). */
  stdout: Uint8Array | null;
  stdoutBytes: number;
  /** Counted, never kept. */
  stderrBytes: number;
  durationMs: number;
  pid: number | null;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): Promise<{ bytes: Uint8Array | null; total: number }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (overflow) continue;
      if (total > cap) {
        overflow = true;
        chunks.length = 0;
        onOverflow();
        continue;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (overflow) return { bytes: null, total };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, total };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Runs `executable` with `argv` once. Never throws for anything the process does. */
export async function runGogProcess(executable: string, argv: readonly string[], options: GogProcessOptions): Promise<GogProcessResult> {
  const started = performance.now();
  let proc: Bun.Subprocess<Uint8Array | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([executable, ...argv], {
      env: { ...options.env },
      cwd: "/",
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch {
    return { end: { kind: "spawn_failed" }, stdout: null, stdoutBytes: 0, stderrBytes: 0, durationMs: performance.now() - started, pid: null };
  }
  let timedOut = false;
  let overflowed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc.pid);
  }, options.timeoutMs);
  const stdout = readCapped(proc.stdout, options.stdoutCap, () => {
    overflowed = true;
    killGroup(proc.pid);
  });
  const stderr = drain(proc.stderr);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  // Whatever gog started dies with it, so no descendant keeps a pipe open.
  killGroup(proc.pid);
  const [out, stderrBytes] = await Promise.all([stdout, stderr]);
  const durationMs = performance.now() - started;
  const base = { stdoutBytes: out.total, stderrBytes, durationMs, pid: proc.pid };
  if (overflowed) return { ...base, end: { kind: "output_too_large" }, stdout: null };
  if (timedOut) return { ...base, end: { kind: "timeout" }, stdout: null };
  if (proc.signalCode) return { ...base, end: { kind: "signal", signal: String(proc.signalCode) }, stdout: null };
  return { ...base, end: { kind: "exit", exitCode }, stdout: out.bytes };
}
