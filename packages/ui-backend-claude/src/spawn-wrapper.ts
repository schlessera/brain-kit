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

export function createWrappedSpawn(
  wrapper: string
): (options: SpawnOptions) => SpawnedProcess {
  return ({ command, args, cwd, env, signal }: SpawnOptions): SpawnedProcess => {
    const child = spawn(wrapper, [command, ...args], {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Group leader: `kill(-pid)` below reaches the wrapper and whatever it
      // started, rather than only the process we can see.
      detached: true,
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
        try {
          process.kill(-child.pid, sig);
          signalled = true;
          return true;
        } catch {
          // ESRCH (already gone) or EPERM (a uid we cannot signal at all).
          // Falling back to the direct kill is no worse than the unwrapped
          // path, and a wrapper whose child outlives an abort is worse than
          // both.
          return child.kill(sig);
        }
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
