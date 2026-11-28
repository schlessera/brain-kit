/**
 * The one way the repository scripts run git (#4730). Every way the former
 * per-script copies differed is a named option; the defaults are what most of
 * them did: array arguments, raw stdout as a string, and a throw on any non-zero
 * exit with `git <args> failed (<code>): <stderr>`.
 */

interface GitOptions {
  /** Trim stdout. */
  trim?: boolean;
  /** Exit codes that return instead of throwing (default `[0]`). */
  allow?: readonly number[];
  /** Bytes or text for stdin (default: no stdin). */
  input?: string | Uint8Array;
  /** Variables added to the inherited environment. */
  env?: Record<string, string>;
  /** `false` passes `-c core.quotePath=false`, so non-ASCII paths come back unquoted. */
  quotePath?: false;
  /** `false` sets `GIT_OPTIONAL_LOCKS=0`, so a status-style refresh never rewrites the index. */
  optionalLocks?: false;
  /** Pass `root` as `git -C <root>` instead of the working directory: an unreachable root fails inside git, with git's message. */
  chdir?: "flag";
  /** The thrown message: a prefix for the trimmed stderr, or a formatter of the raw stderr. */
  error?: string | ((args: readonly string[], code: number | null, stderr: string) => string);
}

export interface GitResult { code: number; stdout: string; stderr: string }

function spawn(root: string, args: readonly string[], options: GitOptions) {
  const env = options.env || options.optionalLocks === false
    ? { ...process.env, ...options.env, ...(options.optionalLocks === false ? { GIT_OPTIONAL_LOCKS: "0" } : {}) } : undefined;
  const command = ["git", ...(options.chdir === "flag" ? ["-C", root] : []), ...(options.quotePath === false ? ["-c", "core.quotePath=false"] : []), ...args];
  return Bun.spawnSync(command, { ...(options.chdir === "flag" ? {} : { cwd: root }), stdout: "pipe", stderr: "pipe",
    stdin: options.input === undefined ? "ignore" : typeof options.input === "string" ? new TextEncoder().encode(options.input) : options.input, ...(env ? { env } : {}) });
}

function refusal(args: readonly string[], code: number | null, stderr: string, error: GitOptions["error"]): Error {
  if (typeof error === "function") return new Error(error(args, code, stderr));
  return new Error(`${error ?? `git ${args.join(" ")} failed (${code}): `}${stderr.trim()}`);
}

/** Runs git in `root` and returns its exit code and output; it throws only for a code outside an explicit `allow`. */
export function gitResult(root: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const result = spawn(root, args, options);
  const stderr = new TextDecoder().decode(result.stderr);
  if (options.allow && (result.exitCode === null || !options.allow.includes(result.exitCode))) throw refusal(args, result.exitCode, stderr, options.error);
  const stdout = new TextDecoder().decode(result.stdout);
  return { code: result.exitCode ?? 1, stdout: options.trim ? stdout.trim() : stdout, stderr };
}

/** Runs git in `root` and returns stdout; throws unless the exit code is allowed. */
export function git(root: string, args: readonly string[], options: GitOptions & { encoding: "buffer" }): Buffer;
export function git(root: string, args: readonly string[], options?: GitOptions & { encoding?: "string" }): string;
export function git(root: string, args: readonly string[], options: GitOptions & { encoding?: "string" | "buffer" } = {}): string | Buffer {
  const result = spawn(root, args, options);
  if (result.exitCode === null || !(options.allow ?? [0]).includes(result.exitCode)) throw refusal(args, result.exitCode, new TextDecoder().decode(result.stderr), options.error);
  if (options.encoding === "buffer") return Buffer.from(result.stdout);
  const stdout = new TextDecoder().decode(result.stdout);
  return options.trim ? stdout.trim() : stdout;
}
