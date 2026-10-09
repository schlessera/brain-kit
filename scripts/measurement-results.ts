/** Native measurement receipts survive an SDK iterator rejecting its result. */
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export class MeasurementResults {
  results: Record<string, any>[] = [];
  processes: Array<{ closed: boolean; stdoutFinished: boolean; code: number | null; signal: string | null; forcedKill: boolean }> = [];
  private pending: Array<{ done: Promise<void>; stream: Transform; receipt: MeasurementResults["processes"][number]; kill: () => void }> = [];

  spawn = (options: SpawnOptions) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"],
    });
    const receipt = { closed: false, stdoutFinished: false, code: null as number | null, signal: null as string | null, forcedKill: false };
    this.processes.push(receipt);
    const decoder = new StringDecoder("utf8"); let buffered = "";
    const parse = (line: string) => {
      let frame: Record<string, any>;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame?.type === "result") this.results.push(frame);
    };
    const accept = (text: string) => {
      buffered += text; let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
      }
    };
    const stream = new Transform({
      transform(chunk, _encoding, callback) { accept(decoder.write(chunk)); callback(null, chunk); },
      flush(callback) { accept(decoder.end()); parse(buffered); buffered = ""; callback(); },
    });
    // Returning from SDK iteration must not discard a late native receipt.
    stream[Symbol.asyncIterator] = () => stream.iterator({ destroyOnReturn: false });
    const closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      receipt.closed = true; receipt.code = code; receipt.signal = signal; resolve();
    }));
    const finished = new Promise<void>(resolve => {
      stream.once("finish", () => { receipt.stdoutFinished = true; resolve(); });
      stream.once("error", () => resolve());
      stream.once("close", () => resolve());
      child.stdout.once("error", () => resolve());
    });
    child.stdout.pipe(stream); child.stderr.on("data", () => {});
    this.pending.push({ done: Promise.all([closed, finished]).then(() => {}), stream, receipt,
      kill: () => { receipt.forcedKill = true; child.kill("SIGKILL"); },
    });
    return { stdin: child.stdin, stdout: stream,
      get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
    };
  };

  async drain(timeoutMs = 5000): Promise<boolean> {
    for (const { stream } of this.pending) stream.resume();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = Promise.all(this.pending.map(p => p.done));
      const drained = await Promise.race([done.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      if (!drained) {
        for (const pending of this.pending) if (!pending.receipt.closed) pending.kill();
        // Window release requires actual close/flush, even after the deadline.
        await done;
        return false;
      }
      return this.processes.every(p => p.closed && p.stdoutFinished);
    } finally { clearTimeout(timer); }
  }
}

export function knownCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function knownPrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function priceCoverage(rows: readonly { costUsd: number | null }[]) {
  const known = rows.flatMap(r => { const cost = knownPrice(r.costUsd); return cost === null ? [] : [cost]; });
  return { known: known.length, missing: rows.length - known.length,
    knownSubtotalUsd: known.reduce((sum, cost) => sum + cost, 0),
    totalUsd: known.length === rows.length ? known.reduce((sum, cost) => sum + cost, 0) : null };
}
