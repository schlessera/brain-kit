/** Private native stdout tee. Raw bytes remain recoverable when SDK iteration fails. */
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
const knownCounter = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function rawTee(retain: (chunk: Buffer)=>void, observe:(line:string)=>void) {
 const decoder=new StringDecoder("utf8");let pending="";
 const accept=(text:string)=>{pending+=text;let at:number;while((at=pending.indexOf("\n"))>=0){observe(pending.slice(0,at));pending=pending.slice(at+1);}};
 return new Transform({transform:(chunk,_encoding,done)=>{retain(Buffer.from(chunk));accept(decoder.write(chunk));done(null,chunk);},
  flush:done=>{accept(decoder.end());if(pending)observe(pending);pending="";done();}});
}
export class NativeEvidence {
  readonly native = { results: [] as Record<string, any>[], processes: [] as Array<{
    closed: boolean; stdoutFinished: boolean; code: number | null; signal: string | null; forcedKill: boolean; error: string | null;
  }> };
  readonly frames: Record<string, unknown>[] = [];
  readonly parseErrors: string[] = [];
  private chunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private pending: Array<{ stream: Transform; done: Promise<void>; kill(): void }> = [];
  rawBytes() { return Buffer.concat(this.chunks); }
  rawStderr() { return Buffer.concat(this.stderrChunks); }
  spawn = (options: SpawnOptions) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"] });
    const receipt = { closed: false, stdoutFinished: false, code: null as number | null, signal: null as string | null,
      forcedKill: false, error: null as string | null };
    this.native.processes.push(receipt);
    child.stderr.on("data", chunk => this.stderrChunks.push(Buffer.from(chunk)));
    child.on("error", error => { receipt.error = String(error); });
    const parse = (line: string) => {
      if (!line.trim()) return;
      try {
        const frame: unknown = JSON.parse(line);
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) throw new Error("native frame must be an object");
        this.frames.push(frame as Record<string, unknown>);
        if ((frame as Record<string, unknown>).type === "result") this.native.results.push(frame as Record<string, any>);
      } catch (error) { this.parseErrors.push(String(error)); }
    };
    const tee = rawTee(chunk => this.chunks.push(chunk), parse);
    tee[Symbol.asyncIterator] = () => tee.iterator({ destroyOnReturn: false });
    const closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      receipt.closed = true; receipt.code = code; receipt.signal = signal; resolve();
    }));
    const finished = new Promise<void>(resolve => {
      tee.once("finish", () => { receipt.stdoutFinished = true; resolve(); });
      tee.once("close", () => resolve());
      tee.once("error", error => { receipt.error ??= String(error); resolve(); });
    });
    child.stdout.on("error", error => { receipt.error ??= String(error); tee.destroy(error); });
    child.stdout.pipe(tee);
    this.pending.push({ stream: tee, done: Promise.all([closed, finished]).then(() => {}),
      kill: () => { receipt.forcedKill = true; child.kill("SIGKILL"); } });
    return { stdin: child.stdin, stdout: tee, get killed() { return child.killed; },
      get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
  };
  async drain(timeoutMs = 5000) {
    for (const entry of this.pending) entry.stream.resume();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = Promise.all(this.pending.map(entry => entry.done));
      const normal = await Promise.race([done.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
      if (!normal) { this.pending.forEach(entry => entry.kill()); await done; return false; }
      return this.native.processes.every(p => p.closed && p.stdoutFinished && p.error === null);
    } finally { clearTimeout(timer); }
  }
  /** Final all-model native usage, never provisional assistant frame counters. */
  accounting() {
    const result = this.native.results.at(-1);
    const usage = result?.modelUsage;
    const models = usage && typeof usage === "object" && !Array.isArray(usage) ? Object.entries(usage) : [];
    const rows = models.map(([model, value]) => {
      const row = value as Record<string, unknown> | null;
      return { model, input: knownCounter(row?.inputTokens), output: knownCounter(row?.outputTokens),
        cacheRead: knownCounter(row?.cacheReadInputTokens), cacheWrite: knownCounter(row?.cacheCreationInputTokens), raw: value };
    });
    const complete = this.native.processes.length === 1 && this.native.results.length === 1 && this.native.processes.every(p => p.closed && p.stdoutFinished && !p.forcedKill && p.error === null) &&
      this.parseErrors.length === 0 && rows.length > 0 && rows.every(r => r.model === "claude-sonnet-5-5" &&
        [r.input, r.output, r.cacheRead, r.cacheWrite].every(v => v !== null));
    return { complete, rows, result: result ?? null, retainedResults: [...this.native.results], actualAdditionalBilledUsd: null,
      scope: "native final all-model usage; physical HTTP count requires separate transport evidence" };
  }
}
