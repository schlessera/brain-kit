/**
 * The PDF extractor's parent half (#3154, docs/plans/chat-attachments.md
 * §7.3): one short-lived child per read, at most `concurrency` at once per
 * host, each bounded by wall clock, CPU and per-process memory, and killed
 * when its turn is cancelled. The verified original crosses on stdin, so the
 * child opens no path and the bytes it reads are the bytes the host checked.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AttachmentReadFailure } from "@schlessera/brain-ui-sdk/tool-contracts";
import { subprocessEnv } from "../config/env.js";
import type { ExtractRequest, ExtractResponse } from "./extract-protocol.js";

interface ExtractorBounds {
  /** Wall clock per call; the parent kills the child at it. */
  timeoutMs: number;
  /** `RLIMIT_CPU`, in seconds, when `prlimit` is present. */
  cpuSeconds: number;
  /** `RLIMIT_DATA`, in bytes, when `prlimit` is present. */
  dataBytes: number;
  /** Children running at once on this host; the rest queue. */
  concurrency: number;
}

/** The design's bounds, kept after the 500-page measurement (docs/decisions/chat-attachments.md). */
export const EXTRACTOR_BOUNDS: Readonly<ExtractorBounds> = Object.freeze({
  timeoutMs: 30_000, cpuSeconds: 20, dataBytes: 1_073_741_824, concurrency: 2,
});

/** The child's answer stays small: 64 KiB of text plus its JSON frame. */
const MAX_STDOUT_BYTES = 1_048_576;
/** The sibling child module: `.ts` from source, `.js` from the build. */
const WORKER = fileURLToPath(new URL(`./extract-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));

type ExtractResult = ExtractResponse | { outcome: "failed"; reason: AttachmentReadFailure } | { outcome: "unavailable" } | { outcome: "cancelled" };

/** Fixed system locations only, as the worker launcher looks for it. */
function findPrlimit(): string | null {
  for (const path of ["/usr/bin/prlimit", "/bin/prlimit", "/usr/sbin/prlimit", "/sbin/prlimit"]) {
    try { if (statSync(path).isFile()) return path; } catch { /* next */ }
  }
  return null;
}

/** This process's hard limit for one `/proc/self/limits` row, or null when unlimited or unknown. */
function hardLimit(row: string): number | null {
  try {
    const line = readFileSync("/proc/self/limits", "utf8").split("\n").find((l) => l.startsWith(row));
    const hard = line?.slice(row.length).trim().split(/\s+/)[1];
    return hard && hard !== "unlimited" ? Number(hard) : null;
  } catch { return null; }
}

/** A FIFO semaphore whose waiters leave the queue when their signal aborts. */
function semaphore(size: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false;
      if (running < size) { running++; return true; }
      return new Promise<boolean>((resolve) => {
        const go = () => { signal.removeEventListener("abort", stop); running++; resolve(true); };
        const stop = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); resolve(false); };
        waiting.push(go);
        signal.addEventListener("abort", stop, { once: true });
      });
    },
    release() { running--; waiting.shift()?.(); },
  };
}

export interface Extractor {
  extract(bytes: Uint8Array, request: ExtractRequest, signal: AbortSignal): Promise<ExtractResult>;
  /** Whether per-process CPU and memory limits apply; the wall clock always does. */
  readonly limited: boolean;
}

export function createExtractor(bounds: Partial<ExtractorBounds> = {}, options: { prlimit?: string | null; worker?: string } = {}): Extractor {
  const b = { ...EXTRACTOR_BOUNDS, ...bounds };
  const prlimit = options.prlimit === undefined ? findPrlimit() : options.prlimit;
  const worker = options.worker ?? WORKER;
  const slots = semaphore(b.concurrency);
  // An unprivileged process cannot raise its hard limit, so lower ours to it.
  const lowered = (wanted: number, row: string) => { const hard = hardLimit(row); return hard === null ? wanted : Math.min(wanted, hard); };
  const cpu = lowered(b.cpuSeconds, "Max cpu time"), data = lowered(b.dataBytes, "Max data size");
  const limits = prlimit ? [prlimit, `--cpu=${cpu}:${cpu}`, `--data=${data}:${data}`, "--"] : [];
  // Nothing of the server's environment but PATH: no credentials, no brain paths.
  const env = { PATH: subprocessEnv("brainCli").PATH ?? "/usr/bin:/bin" };

  async function run(bytes: Uint8Array, request: ExtractRequest, signal: AbortSignal): Promise<ExtractResult> {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([...limits, process.execPath, worker, JSON.stringify(request)], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore", env,
      });
    } catch { return { outcome: "unavailable" }; }
    let timedOut = false, cancelled = false;
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, b.timeoutMs);
    const abort = () => { cancelled = true; kill(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const stdin = child.stdin as import("bun").FileSink;
      try { stdin.write(bytes); await stdin.end(); } catch { /* the child died; its exit says why */ }
      const out = await readBounded(child.stdout as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES);
      const code = await child.exited;
      if (cancelled) return { outcome: "cancelled" };
      if (timedOut) return { outcome: "failed", reason: "timeout" };
      // SIGXCPU or the kernel's SIGKILL past the hard CPU limit; SIGABRT when an allocation past RLIMIT_DATA fails.
      if (child.signalCode === "SIGXCPU" || child.signalCode === "SIGKILL" || (prlimit && (child.signalCode === "SIGABRT" || code === 134)))
        return { outcome: "failed", reason: "resource_limit" };
      if (code !== 0 || out === null) return { outcome: "failed", reason: "crash" };
      try { return JSON.parse(new TextDecoder().decode(out)) as ExtractResponse; } catch { return { outcome: "failed", reason: "crash" }; }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  return {
    limited: prlimit !== null,
    async extract(bytes, request, signal) {
      if (!(await slots.acquire(signal))) return { outcome: "cancelled" };
      try { return await run(bytes, request, signal); } finally { slots.release(); }
    },
  };
}

/** The whole stream, or null when it exceeds `max` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
