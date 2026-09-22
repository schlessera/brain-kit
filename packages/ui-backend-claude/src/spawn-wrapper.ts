/**
 * Route the Claude Code subprocess through the host's exec wrapper.
 *
 * The SDK spawns the CLI itself, and `pathToClaudeCodeExecutable` only says
 * WHICH binary — there is no argv seam in front of it. What there is instead
 * is `spawnClaudeCodeProcess`, documented for "VMs, containers, or remote
 * environments", which hands us `{ command, args, cwd, env, signal }` and takes
 * anything satisfying `SpawnedProcess` back. A node `ChildProcess` already
 * satisfies it, so this is the SDK's own spawn with two differences: the
 * wrapper goes in front, and the child leads its own process group.
 *
 * The group is the point. A wrapper that drops privileges makes `kill(2)` fail
 * with EPERM — the server no longer owns the process it is trying to stop, and
 * an aborted turn keeps running. Signalling the group reaches the wrapper
 * itself, which the server does still own.
 *
 * This is installed ONLY when a wrapper is configured. Without one the SDK
 * takes its own path, unchanged, which is where every existing deployment is.
 */
import { spawn } from "node:child_process";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  EXEC_KILLER_ENV,
  wrapCommand,
  type ExecWrapperConfig,
} from "@schlessera/brain-ui-sdk/server";

/**
 * How much of the child's stderr to keep. Bounded on purpose: this hook
 * REPLACES the SDK's own spawn, including the draining the SDK does, and a
 * piped stderr that nobody reads fills its kernel buffer and blocks the child
 * forever. Discarding it outright would be safe too, but a wrapper that fails
 * — the wrong path, a refused uid — says so on stderr, and losing that makes
 * a misconfigured wrapper look like a hang.
 */
const STDERR_TAIL_BYTES = 64 * 1024;

export function createWrappedSpawn(
  config: ExecWrapperConfig
): (options: SpawnOptions) => SpawnedProcess {
  const { wrapper, killer } = config;
  if (!wrapper) throw new Error("createWrappedSpawn requires a wrapper path");
  return ({ command, args, cwd, env, signal }: SpawnOptions): SpawnedProcess => {
    // Through the shared helper, so the SDK's command is resolved to an
    // absolute path like every other wrapped spawn. The SDK hands over a bare
    // `bun` or `node` whenever the CLI is JavaScript, and a wrapper that execs
    // its target cannot look that up on PATH.
    const [resolvedWrapper, program, ...rest] = wrapCommand([command, ...args], wrapper);
    const child = spawn(resolvedWrapper!, [program!, ...rest], {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Group leader: `kill(-pid)` below reaches the wrapper and whatever it
      // started, rather than only the process we can see.
      detached: true,
    });

    // Drain stderr continuously, keeping only a tail. Never awaited, never
    // exposed: the SDK's SpawnedProcess has no stderr member, so this exists
    // solely so the pipe cannot fill.
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.stderr?.on("error", () => {
      /* the child is gone; nothing to read and nothing to report */
    });
    child.once("exit", (code) => {
      if (code !== 0 && stderrTail.trim() !== "") {
        console.error(
          `Claude Code exited ${code} under the exec wrapper ${wrapper}. ` +
            `Last stderr:\n${stderrTail.trimEnd()}`
        );
      }
    });

    // `child.killed` is node's record of "someone called child.kill()", and a
    // group signal never touches it. The SDK reads this to know whether it
    // already asked the process to stop, so it has to reflect OUR kill too.
    let signalled = false;

    // ChildProcess satisfies SpawnedProcess already; only `kill` needs to
    // differ, so everything else delegates rather than being reimplemented.
    return {
      get stdin() {
        return child.stdin!;
      },
      get stdout() {
        return child.stdout!;
      },
      get killed() {
        return signalled || child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill(sig: NodeJS.Signals): boolean {
        if (child.pid === undefined) return false;
        const pid = child.pid;

        /** The unprivileged route: correct unless the wrapper changed uid. */
        const signalGroup = (): boolean => {
          try {
            process.kill(-pid, sig);
            signalled = true;
            return true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ESRCH") return true; // already gone
            const direct = child.kill(sig);
            if (!direct && code === "EPERM") {
              console.error(
                `Could not signal Claude Code's process group ${pid} (EPERM). ` +
                  `The wrapper at ${wrapper} runs as a uid this process cannot signal, ` +
                  `so the aborted turn is STILL RUNNING. Configure ${EXEC_KILLER_ENV}.`
              );
            }
            return direct;
          }
        };

        // An authorised helper is the only thing that works once the wrapper
        // has dropped uid: kill(2) matches uids, and group membership grants
        // no exception (docs/decisions/container-privilege.md, "Cancellation").
        if (killer) {
          const helper = spawn(killer, [String(pid), sig.replace(/^SIG/, "")], {
            stdio: "ignore",
            detached: false,
          });
          helper.unref();
          // A missing or non-executable helper surfaces ASYNCHRONOUSLY here.
          // With no listener, node throws the 'error' event and takes the
          // server down — cancelling a turn would crash the process rather
          // than fall back.
          helper.once("error", (error) => {
            console.error(
              `${EXEC_KILLER_ENV} at ${killer} could not be run to cancel process ` +
                `group ${pid}: ${error.message}. Falling back to an unprivileged signal.`
            );
            signalGroup();
          });
          helper.once("exit", (code) => {
            // Only a clean zero is success. `code === null` means the helper
            // was itself signalled — it crashed or was killed — which cancels
            // nothing at all.
            if (code === 0) return;
            console.error(
              `${EXEC_KILLER_ENV} at ${killer} did not cancel process group ${pid} ` +
                `(exit ${code ?? "by signal"}). Falling back to an unprivileged signal.`
            );
            signalGroup();
          });
          signalled = true;
          return true;
        }

        return signalGroup();
      },
      on(event: "exit" | "error", listener: never) {
        child.on(event, listener);
      },
      once(event: "exit" | "error", listener: never) {
        child.once(event, listener);
      },
      off(event: "exit" | "error", listener: never) {
        child.off(event, listener);
      },
    } as SpawnedProcess;
  };
}
