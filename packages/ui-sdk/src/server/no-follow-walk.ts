/**
 * The no-follow parent walk both output publishers use (#4766): every
 * component of a relative path is opened as a directory through the previous
 * handle, so a symlink planted anywhere on the path is refused. A leaf: it
 * imports neither the launcher nor the sandbox.
 */
import { closeSync, constants, openSync } from "node:fs";

/** Opens a directory, never through a symlink. */
export const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** `name` inside the directory open at `fd`, reached through that handle. */
export const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/**
 * The open parent directory of `rel` under `root`, and the last segment's
 * name; the caller closes `fd`. An empty, `.`, `..` or NUL-holding segment is
 * refused with `invalid` before anything is opened. When a component fails,
 * the walk closes the handle it holds and rethrows.
 */
export function noFollowParent(root: string, rel: string, invalid: string): { fd: number; name: string } {
  const parts = rel.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\u0000"))) throw new Error(invalid);
  let fd = openSync(root, DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) { const next = openSync(at(fd, part), DIRECTORY); closeSync(fd); fd = next; }
    return { fd, name: parts.at(-1)! };
  } catch (error) { closeSync(fd); throw error; }
}
