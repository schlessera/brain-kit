/** Unconditional isolated Claude child; project MCP, tools and descendants inherit it. */
import { EventEmitter } from "node:events";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createTurnTemp, createTurnTempPromoter, launchAgentWorker, mergeLimitReports, requireWorkerHost, WORKER_SCRATCH,
  type TurnTemp, type TurnTempPromotionRecord, type WorkerLimitReport, type WorkerLimitsPlan,
  type WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { wrapCommand, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { restoreArchivedSession } from "./transcript-archive.js";
import { createClaudeWorkerState, validateSessionId } from "./worker-state.js";

/** Promotion of what an answer links in turn temp (#1655), for a turn that keeps its transcript. */
export interface WorkerPromotion {
  /** The host's turn id; absent from an older host. */
  turnId: string | undefined;
  /** What happened to each linked file; called once per worker, after it exited. */
  report(records: TurnTempPromotionRecord[]): void;
  log(level: "warn", message: string): void;
}

/** Validate before either archive or live storage is addressed. */
export function resumedSessionId(args: string[]): string | undefined {
  // The Agent SDK passes `--resume=<id>` as one token; accept the two-token
  // CLI form as well.
  const joined = args.find(arg => arg.startsWith("--resume="));
  const position = args.indexOf("--resume");
  if (joined === undefined && position === -1) return undefined;
  const id = joined !== undefined ? joined.slice("--resume=".length) : args[position + 1] ?? "";
  validateSessionId(id);
  return id;
}

/** The restore and snapshot are one synchronous operation before native spawn. */
export function prepareClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>, args: string[],
  options: Parameters<typeof createClaudeWorkerState>[2] = {}) {
  const resume = options.ephemeral ? undefined : resumedSessionId(args);
  if (resume) restoreArchivedSession(resume, { brainPath, env });
  return createClaudeWorkerState(brainPath, env, { ...options, resume });
}

/**
 * `restricted` selects the autonomous envelope (#676): a private network
 * namespace, an explicit read envelope holding only the executable, empty
 * runtime state, and the relay directory as the one route out.
 */
export function createWorkerSpawn(brainPath: string, config: ExecWrapperConfig, immediateSignal: AbortSignal,
  restricted?: { inferenceDir: string }, sandbox?: WorkerSandbox, limitsPlan?: WorkerLimitsPlan, promotion?: WorkerPromotion) {
  const completions: Promise<void>[] = [];
  const reports: Array<() => WorkerLimitReport> = [];
  const limits = () => mergeLimitReports(reports.map(report => report()));
  return {
    /** The resource limits this turn's workers hit so far (#1660). */
    limits,
    /** The same, once the workers have exited or `waitMs` has passed. */
    async settledLimits(waitMs = 3_000): Promise<WorkerLimitReport> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(completions), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
      return limits();
    },
    spawn({ command, args, env, signal }: SpawnOptions): SpawnedProcess {
      requireWorkerHost(brainPath, { restricted: Boolean(restricted) });
      immediateSignal.throwIfAborted();
      const state = prepareClaudeWorkerState(brainPath, env, args, { ephemeral: Boolean(restricted) });
      // Host-visible turn temp, so what the answer links there can be
      // promoted once the worker has exited (#1655). Never for the restricted envelope.
      let turnTemp: TurnTemp | null = null;
      if (promotion && !restricted && sandbox) {
        try { turnTemp = createTurnTemp(brainPath); } catch (error) { state.cleanup(); throw error; }
        if (!turnTemp) promotion.log("warn", "no private tmpfs for turn temp; files the answer links there cannot be promoted");
      }
      const emitter = new EventEmitter();
      let worker: ReturnType<typeof launchAgentWorker>;
      try {
        const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        childEnv.CLAUDE_CONFIG_DIR = state.path;
        if (restricted) {
          // No host home exists in the envelope; runtime state is the fresh tmpfs.
          childEnv.HOME = state.path;
          // The executable and any script it is handed, and nothing else of the
          // host. No operator exec wrapper: it is ambient host configuration.
          const readPaths = [command, ...args.filter(arg => isAbsolute(arg) && existsSync(arg) && statSync(arg).isFile())];
          worker = launchAgentWorker({ brainPath, statePath: state.path, command: [command, ...args], env: childEnv,
            restricted: { readPaths, inferenceDir: restricted.inferenceDir }, ...(sandbox ? { sandbox } : {}),
            ...(limitsPlan ? { limits: limitsPlan } : {}) });
        } else {
          worker = launchAgentWorker({ brainPath, statePath: state.path,
            command: wrapCommand([command, ...args], config.wrapper), env: childEnv, ...(sandbox ? { sandbox } : {}),
            ...(limitsPlan ? { limits: limitsPlan } : {}), ...(turnTemp ? { turnTemp } : {}) });
        }
      } catch (error) { try { state.cleanup(); } finally { turnTemp?.cleanup(); } throw error; }
      reports.push(worker.limitReport);
      let killed = false, exitCode: number | null = null, signalCode: NodeJS.Signals | null = null;
      let tail = "";
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (data: string) => { tail = (tail + data).slice(-65536); });
      worker.stderr.on("error", error => emitter.emit("error", error));
      const kill = (sig: NodeJS.Signals): boolean => { killed = true; signalCode = sig; worker.kill(sig); return true; };
      const abort = () => kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || immediateSignal.aborted) abort();
      const done = worker.exited.then(code => {
        exitCode = code;
        signal.removeEventListener("abort", abort);
        // bwrap's PID namespace dies with its init, including detached children,
        // so nothing writes turn temp or the transcripts while they are read.
        const promoter = turnTemp && promotion && sandbox ? createTurnTempPromoter({ brain: sandbox.brain, turnTemp,
          turnId: promotion.turnId, scratch: WORKER_SCRATCH, exclude: [state.path],
          home: sandbox.home?.mode === "overlay" ? sandbox.home.path : undefined,
          scratchWritable: sandbox.areas.some(area => area.name === "scratch" && area.mount.writable) }) : undefined;
        try { state.persist(promoter?.rewrite); }
        finally { if (promoter?.records.length) promotion!.report(promoter.records); }
        if (code !== 0 && !killed && tail.trim()) console.error(`Claude worker exited ${code}: ${tail.trim()}`);
        emitter.emit("exit", killed ? null : code, signalCode);
      }).catch(error => { emitter.emit("error", error); throw error; }).finally(() => { try { state.cleanup(); } finally { turnTemp?.cleanup(); } });
      completions.push(done);
      // Lifecycle is also awaited by the turn, so rejections cannot go unhandled.
      void done.catch(() => {});
      return { stdin: worker.stdin, stdout: worker.stdout, get killed() { return killed; },
        get exitCode() { return exitCode; }, get signalCode() { return signalCode; }, kill,
        on: emitter.on.bind(emitter), once: emitter.once.bind(emitter), off: emitter.off.bind(emitter) } as SpawnedProcess;
    },
    async finish() { await Promise.all(completions); },
  };
}
