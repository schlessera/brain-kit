/**
 * The one way the repository scripts run the GitHub CLI, and the one place the
 * default repository and its override are spelled (#4731).
 */

export interface GhResult { code: number; stdout: string; stderr: string }
/** Runs `gh` with these arguments. Tests replace it; nothing else reaches the network. */
export type Gh = (args: string[]) => GhResult;

export const DEFAULT_REPO = "schlessera/brain-kit";

/** The real synchronous `gh`: its exit code and both streams, never a throw. */
export const realGh = (args: string[], cwd?: string): GhResult => {
  const result = Bun.spawnSync(["gh", ...args], { ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

interface GhOptions {
  /** Text for stdin (default: no stdin). */
  input?: string;
  /** Trim stdout. */
  trim?: boolean;
  /** The thrown message for a non-zero exit (default `gh <args> failed (<code>):\n<trimmed stderr>`). */
  error?: (args: readonly string[], code: number, stderr: string) => string;
}

/** Runs `gh` and resolves to its stdout; rejects on a non-zero exit. */
export async function gh(args: readonly string[], options: GhOptions = {}): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe",
    stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input) });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(options.error ? options.error(args, code, stderr) : `gh ${args.join(" ")} failed (${code}):\n${stderr.trim()}`);
  return options.trim ? stdout.trim() : stdout;
}

/** The repository a script acts on: its `--repo` option, else `BRAIN_KIT_REPOSITORY`, else the default. */
export function resolveRepository({ flag, env = process.env }: { flag?: string; env?: Record<string, string | undefined> } = {}): string {
  return flag ?? env.BRAIN_KIT_REPOSITORY ?? DEFAULT_REPO;
}
