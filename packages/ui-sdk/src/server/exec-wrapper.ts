/**
 * The exec wrapper: a host-supplied executable that every agent subprocess is
 * launched through.
 *
 * Both backends spawn processes that can load or execute content from the
 * brain repository, and until now neither could be told to spawn them as
 * somebody else. A container that wants its agent to run as a less privileged
 * user has nowhere to say so — the decision was a build-time fact of whatever
 * image was in front of it. This exposes the seam; nothing in this repository
 * sets it, and nothing ships a wrapper.
 *
 * Two properties are load-bearing, and both are the reason this is a shared
 * module rather than three call sites that each do something slightly
 * different:
 *
 * 1. **A wrapper is a PATH, never a prefix string.** `wrapCommand` puts it in
 *    argv position 0 and leaves the program in position 1; no shell is
 *    involved, so a value full of metacharacters is a filename that does not
 *    exist rather than a command that runs. A prefix — `"sudo -u brain"`, say
 *    — would have to be split, and splitting is the injection.
 * 2. **A wrapped child is its own process group, and abort kills the group.**
 *    A uid drop breaks `kill(2)`: the server gets EPERM signalling a child it
 *    no longer owns, and a turn keeps running after the user aborted it.
 *    Killing the group gives the wrapper's own process — which the server does
 *    still own — the signal, and it is the wrapper's job to take its child down
 *    with it. Without a wrapper nothing is detached and nothing changes.
 *
 * With no wrapper configured every function here is the identity: the argv is
 * the argv, the spawn options are empty, and a kill is the plain kill it
 * always was. That path is what every existing deployment is on.
 */
import { isAbsolute } from "node:path";

/** The environment variable each package's chokepoint reads this from. */
export const EXEC_WRAPPER_ENV = "BRAIN_UI_EXEC_WRAPPER";

/**
 * Validate a configured wrapper, or `undefined` when there is none.
 *
 * Shared so the three packages that accept it cannot disagree about what is
 * acceptable. Absolute only: a relative path resolves against the working
 * directory of whichever process spawns, which for an agent subprocess is the
 * brain repository — a directory whose contents the agent itself can write.
 *
 * @throws if the value is set but unusable. Failing at configuration time is
 * the point: a wrapper that silently does not apply is a privilege boundary
 * that silently does not exist.
 */
export function validateExecWrapper(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) {
    throw new Error(
      `${EXEC_WRAPPER_ENV} must be an absolute path to an executable, got ${JSON.stringify(value)}. ` +
        "It is an argv[0], not a command line: no shell parses it, so arguments and " +
        "metacharacters cannot be part of it."
    );
  }
  return value;
}

/**
 * `[program, ...args]` → `[wrapper, program, ...args]`, or unchanged when no
 * wrapper is configured.
 */
export function wrapCommand(argv: readonly string[], wrapper?: string): string[] {
  return wrapper ? [wrapper, ...argv] : [...argv];
}

/**
 * Spawn options to merge in. Empty without a wrapper, so an unwrapped spawn is
 * byte-identical to what it was before this existed.
 */
export function execWrapperSpawnOptions(wrapper?: string): { detached?: true } {
  return wrapper ? { detached: true } : {};
}

/** The slice of a spawned process this needs; Bun's Subprocess satisfies it. */
export interface KillableProcess {
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Abort a spawn made through {@link execWrapperSpawnOptions}.
 *
 * With a wrapper, signal the whole process group — the wrapper is the group
 * leader, and the process actually doing the work is its child, possibly under
 * another uid. Without one, the plain `kill()` that was always here.
 *
 * A group kill that fails falls back to killing the process directly: a
 * wrapper whose child outlives the signal is a worse outcome than a wrapper
 * that behaves like the old path.
 */
export function killWrapped(
  proc: KillableProcess,
  wrapper?: string,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  if (!wrapper) {
    proc.kill();
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // ESRCH (already gone) or EPERM (a uid we cannot signal at all). Either
    // way the direct kill is the only remaining move.
    try {
      proc.kill(signal);
    } catch {
      /* already reaped */
    }
  }
}
