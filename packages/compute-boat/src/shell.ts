/**
 * The shell text the adapter sends as a Boat command. Every value is single
 * quoted, so nothing the host passes is interpreted by the sandbox shell.
 */

/** The work directory under the sandbox user's home (`/home/user`), where commands start. */
export const WORK_DIR = "work";
/** The same directory as an absolute path, for file API calls that do not promise to resolve a relative one. */
export const WORK_PATH = `/home/user/${WORK_DIR}`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUL = "\u0000";

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A relative path with no `..`, no absolute root and no empty segment, or undefined. */
export function safeRelative(path: string): string | undefined {
  if (path.includes(NUL) || path.includes("\\")) return undefined;
  const trimmed = path.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return "";
  if (trimmed.startsWith("/")) return undefined;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

/**
 * `cd` into the work directory (and `cwd` under it), then run `argv` with
 * exactly the allowlisted variables added. Returns undefined when an input
 * cannot be expressed safely.
 */
export function commandLine(argv: string[], env: Record<string, string>, cwd?: string): string | undefined {
  if (argv.length === 0 || argv[0]!.includes("=")) return undefined;
  const dir = cwd === undefined ? "" : safeRelative(cwd);
  if (dir === undefined) return undefined;
  const values = [...argv, ...Object.entries(env).flat()];
  if (values.some((value) => value.includes(NUL))) return undefined;
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) return undefined;
    pairs.push(quote(`${name}=${value}`));
  }
  const target = dir === "" ? WORK_DIR : `${WORK_DIR}/${dir}`;
  return [`mkdir -p ${WORK_DIR} && cd ${quote(target)} && exec env --`, ...pairs, ...argv.map(quote)].join(" ");
}
