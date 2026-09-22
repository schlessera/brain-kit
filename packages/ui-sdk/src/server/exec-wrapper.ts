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
 * The companion helper that cancels a wrapped process group.
 *
 * Needed because signalling is not a matter of ownership of the group.
 * `kill(2)` requires the sender's real or effective uid to match the target's
 * real or saved set-uid, and parenthood and process-group membership grant no
 * exception — so once a wrapper has dropped to another uid and exec'd in
 * place, the server can signal nothing at all and the turn keeps running after
 * an abort. That is measured, not theorised:
 * `docs/decisions/container-privilege.md`, "Cancellation".
 *
 * A host that drops privileges therefore supplies a narrowly authorised
 * helper, invoked as `<killer> <pgid> <TERM|KILL|INT>`. This repository
 * neither ships one nor requires one: with no killer configured the group
 * signal is attempted directly, which is correct whenever the wrapper has not
 * changed uid.
 */
export const EXEC_KILLER_ENV = "BRAIN_UI_EXEC_KILLER";

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
 * `[program, ...args]` → `[wrapper, /absolute/program, ...args]`, or unchanged
 * when no wrapper is configured.
 *
 * The program is resolved to an absolute path, for two reasons that point the
 * same way. A helper of the shape this seam is built for becomes the target
 * with `execv` and does no PATH lookup, so a bare `bash` is simply refused.
 * And the security reason underneath that: `PATH` in a subprocess environment
 * must not get to choose which `bash` runs, because agent-writable code on it
 * would then be selected by the very mechanism meant to contain the agent
 * (`docs/decisions/container-privilege.md`, "Use absolute commands").
 *
 * Resolution uses THIS process's PATH, which the agent cannot write, and
 * happens only on the wrapped path — an unwrapped spawn passes the argv
 * through exactly as before.
 *
 * @throws when a wrapper is configured and the program cannot be resolved.
 * Failing here beats handing a helper something it will refuse for reasons the
 * operator then has to guess at.
 */
export function wrapCommand(argv: readonly string[], wrapper?: string): string[] {
  if (!wrapper) return [...argv];
  const [program, ...args] = argv;
  if (program === undefined) throw new Error("wrapCommand needs a program to run");
  return [wrapper, absoluteProgram(program, wrapper), ...args];
}

function absoluteProgram(program: string, wrapper: string): string {
  if (isAbsolute(program)) return program;
  const resolved = Bun.which(program);
  if (!resolved) {
    throw new Error(
      `Cannot run ${JSON.stringify(program)} through the exec wrapper at ${wrapper}: ` +
        "it is not an absolute path and was not found on this process's PATH. A wrapper " +
        "execs its target directly, and an absolute path is also what keeps PATH from " +
        "selecting agent-writable code."
    );
  }
  return resolved;
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

/** What the host configured. Both halves are independent and both optional. */
export interface ExecWrapperConfig {
  /** Absolute path every subprocess is launched through. */
  wrapper?: string;
  /** Absolute path to the authorised group-cancellation helper. */
  killer?: string;
}

/**
 * Abort a spawn made through {@link execWrapperSpawnOptions}.
 *
 * Three cases, in the order they are tried:
 *
 * 1. **No wrapper** — the plain `kill()` that was always here.
 * 2. **A killer helper** — `<killer> <pgid> <SIGNAL>`. The only thing that
 *    works once the wrapper has dropped uid, because then nothing in the group
 *    is signallable by this process.
 * 3. **A wrapper and no killer** — signal the group directly. Correct when the
 *    wrapper supervises at the server's own uid; guaranteed to fail with
 *    EPERM when it has exec'd in place as somebody else.
 *
 * A total failure is REPORTED, never swallowed: a turn that keeps running
 * after the user aborted it, with nothing in the log, is the outcome this
 * whole seam exists to avoid.
 */
export function killWrapped(
  proc: KillableProcess,
  config: ExecWrapperConfig = {},
  signal: NodeJS.Signals = "SIGTERM",
  onFailure: (message: string) => void = (message) => console.error(message)
): void {
  const { wrapper, killer } = config;
  if (!wrapper) {
    // The requested signal, not the default: `execBrain` asks for SIGKILL when
    // a pipe read fails, and a CLI that ignores SIGTERM would otherwise
    // survive until the search deadline. Dropping it here was a regression on
    // the path every existing deployment is on.
    proc.kill(signal);
    return;
  }

  /** The unprivileged route: correct unless the wrapper changed uid. */
  const signalGroup = (): void => {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") return; // already gone is a success
      try {
        proc.kill(signal);
        return;
      } catch (direct) {
        if ((direct as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return;
      }
      onFailure(
        `Could not signal process group ${proc.pid} (${code ?? "unknown error"}). ` +
          `The wrapper at ${wrapper} appears to run as a uid this process cannot signal, ` +
          `so the aborted work is STILL RUNNING. Configure ${EXEC_KILLER_ENV} with an ` +
          "authorised cancellation helper — see docs/decisions/container-privilege.md."
      );
    }
  };

  if (!killer) {
    signalGroup();
    return;
  }

  let helper: { exited: Promise<number> };
  try {
    helper = Bun.spawn([killer, String(proc.pid), signal.replace(/^SIG/, "")], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    onFailure(
      `${EXEC_KILLER_ENV} at ${killer} could not be run to cancel process group ` +
        `${proc.pid}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Falling back to an unprivileged signal, which fails if the wrapper changed uid."
    );
    signalGroup();
    return;
  }

  // Not awaited — an abort path must not wait on a process spawn — but not
  // ignored either. A helper that starts and then fails its own privilege
  // transition exits non-zero and kills nothing, and reporting that as a
  // successful cancellation is how a turn keeps running with a clean log.
  void helper.exited.then(
    (code) => {
      if (code === 0) return;
      onFailure(
        `${EXEC_KILLER_ENV} at ${killer} exited ${code} cancelling process group ` +
          `${proc.pid}. Falling back to an unprivileged signal, which fails if the ` +
          "wrapper changed uid."
      );
      signalGroup();
    },
    (error: unknown) => {
      onFailure(
        `${EXEC_KILLER_ENV} at ${killer} failed cancelling process group ${proc.pid}: ` +
          `${error instanceof Error ? error.message : String(error)}.`
      );
      signalGroup();
    }
  );
}
