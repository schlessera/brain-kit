/** Unconditional isolated Claude child; project MCP, tools and descendants inherit it. */
import { EventEmitter } from "node:events";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { launchAgentWorker, requireWorkerHost } from "@schlessera/brain-ui-sdk/internal";
import { wrapCommand, type ExecWrapperConfig, type TurnFailure } from "@schlessera/brain-ui-sdk/server";
import { restoreArchivedSession } from "./transcript-archive.js";
import { WorkerStateError } from "./worker-state-budget.js";
import { createClaudeWorkerState, validateSessionId } from "./worker-state.js";

/** How often a running turn's state is measured against its reservation (#1625). */
export const STATE_CHECK_MS = 250;

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
  restricted?: { inferenceDir: string },
  stateOptions: Pick<NonNullable<Parameters<typeof createClaudeWorkerState>[2]>, "stateRoot" | "ledger"> = {},
  checkMs = STATE_CHECK_MS) {
  const completions: Promise<void>[] = [];
  /**
   * The first worker-state refusal or stop (#1625). The runtime only sees a
   * failed spawn or a killed process, so the turn reports this instead.
   */
  let failure: TurnFailure | undefined;
  const record = (error: unknown) => {
    if (!failure && error instanceof WorkerStateError) failure = { errorClass: error.errorClass, message: error.message };
  };
  /** Live states' measurements, so asking for the failure also measures now. */
  const checks = new Set<() => boolean>();
  return {
    spawn({ command, args, env, signal }: SpawnOptions): SpawnedProcess {
      requireWorkerHost(brainPath, { restricted: Boolean(restricted) });
      immediateSignal.throwIfAborted();
      let state: ReturnType<typeof createClaudeWorkerState>;
      try { state = prepareClaudeWorkerState(brainPath, env, args, { ...stateOptions, ephemeral: Boolean(restricted) }); }
      catch (error) { record(error); throw error; }
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
            restricted: { readPaths, inferenceDir: restricted.inferenceDir } });
        } else {
          worker = launchAgentWorker({ brainPath, statePath: state.path,
            command: wrapCommand([command, ...args], config.wrapper), env: childEnv });
        }
      } catch (error) { state.cleanup(); throw error; }
      let killed = false, exitCode: number | null = null, signalCode: NodeJS.Signals | null = null;
      let tail = "";
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (data: string) => { tail = (tail + data).slice(-65536); });
      worker.stderr.on("error", error => emitter.emit("error", error));
      const kill = (sig: NodeJS.Signals): boolean => { killed = true; signalCode = sig; worker.kill(sig); return true; };
      const abort = () => kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || immediateSignal.aborted) abort();
      // A turn that outgrows its reservation extends it into space no other
      // turn holds; one that cannot is stopped by name before the shared tmpfs
      // runs out under another turn (#1625).
      const check = () => { try { state.ensure(); return true; } catch (error) { record(error); return false; } };
      const monitor = setInterval(() => { if (!check() && !killed) kill("SIGKILL"); }, checkMs);
      checks.add(check);
      const done = worker.exited.then(code => {
        exitCode = code;
        clearInterval(monitor);
        signal.removeEventListener("abort", abort);
        // An overshoot since the last tick is still named, not lost. A turn
        // whose result already streamed stays completed, so log it too.
        if (!check()) console.error(`Claude worker runtime state: ${failure?.message ?? "over its reservation"}`);
        // bwrap's PID namespace dies with its init, including detached children.
        state.persist();
        if (code !== 0 && !killed && tail.trim()) console.error(`Claude worker exited ${code}: ${tail.trim()}`);
        emitter.emit("exit", killed ? null : code, signalCode);
      }).catch(error => { emitter.emit("error", error); throw error; })
        .finally(() => { clearInterval(monitor); checks.delete(check); state.cleanup(); });
      completions.push(done);
      // Lifecycle is also awaited by the turn, so rejections cannot go unhandled.
      void done.catch(() => {});
      return { stdin: worker.stdin, stdout: worker.stdout, get killed() { return killed; },
        get exitCode() { return exitCode; }, get signalCode() { return signalCode; }, kill,
        on: emitter.on.bind(emitter), once: emitter.once.bind(emitter), off: emitter.off.bind(emitter) } as SpawnedProcess;
    },
    async finish() { await Promise.all(completions); },
    /** Why the worker's runtime state refused or stopped the turn, if it did (#1625). */
    failure(): TurnFailure | undefined { for (const check of checks) check(); return failure; },
  };
}
