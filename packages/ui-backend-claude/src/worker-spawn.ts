/** Unconditional isolated Claude child; project MCP, tools and descendants inherit it. */
import { EventEmitter } from "node:events";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { launchAgentWorker, requireWorkerHost } from "@schlessera/brain-ui-sdk/internal";
import { wrapCommand, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { createClaudeWorkerState } from "./worker-state.js";

export function createWorkerSpawn(brainPath: string, config: ExecWrapperConfig, immediateSignal: AbortSignal) {
  const completions: Promise<void>[] = [];
  return {
    spawn({ command, args, env, signal }: SpawnOptions): SpawnedProcess {
      requireWorkerHost(brainPath);
      immediateSignal.throwIfAborted();
      const state = createClaudeWorkerState(brainPath, env);
      const emitter = new EventEmitter();
      let worker: ReturnType<typeof launchAgentWorker>;
      try {
        const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        childEnv.CLAUDE_CONFIG_DIR = state.path;
        worker = launchAgentWorker({ brainPath, statePath: state.path,
          command: wrapCommand([command, ...args], config.wrapper), env: childEnv });
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
      const done = worker.exited.then(code => {
        exitCode = code;
        signal.removeEventListener("abort", abort);
        // bwrap's PID namespace dies with its init, including detached children.
        state.persist();
        if (code !== 0 && !killed && tail.trim()) console.error(`Claude worker exited ${code}: ${tail.trim()}`);
        emitter.emit("exit", killed ? null : code, signalCode);
      }).catch(error => { emitter.emit("error", error); throw error; }).finally(state.cleanup);
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
