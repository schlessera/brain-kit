import { randomBytes } from "crypto";
import { resolveContainedSync, type ContainmentPolicy } from "@schlessera/brain-common/internal/safe-path";
import { closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "fs";
import type { Stats } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

const CORE_CONTAINMENT: ContainmentPolicy = { missingRoot: "refuse", danglingLinks: "refuse", components: "every" };

/**
 * Whether a request is refused before it is resolved: anything but a string,
 * an absolute path, and a segment that is `..` or holds `:` or `\\` (#3422).
 * A NUL is refused by the shared resolver.
 */
function refusedRequest(relPath: string): boolean {
  if (typeof relPath !== "string") return true;
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return true;
  return relPath.split("/").some((segment) => segment === ".." || segment.includes(":") || segment.includes("\\"));
}

/**
 * Resolve a repo-relative path and verify it stays inside `root`, following
 * symlinks (realpath) so a symlink inside the repo can't escape it.
 * Returns the canonical absolute path, or null if the path is refused,
 * escapes, or the root itself does not exist.
 *
 * core's row of the shared resolver (`@schlessera/brain-common/internal/safe-path`,
 * #2506), with the strictest answer in every row since #3422: synchronous,
 * `null` for every refusal; an absolute request is refused even inside the
 * root, and so is any `..` segment, even one whose result would stay inside,
 * and `:` or `\\` in a segment; a dangling link is refused wherever it points;
 * and every existing component on the way must stay inside, not only the
 * final path. A caller holding an absolute path passes it relative to the
 * root (`relative(root, abs)`), which a path outside the root turns into a
 * refused `..`.
 */
export function safeResolve(root: string, relPath: string): string | null {
  if (refusedRequest(relPath)) return null;
  const contained = resolveContainedSync(root, relPath, CORE_CONTAINMENT);
  return contained.ok ? contained.canonical : null;
}

/**
 * Re-check a path the caller already holds as absolute: a canonical answer
 * `safeResolve` gave earlier, or a file core located itself (the brain's
 * config). It is `safeResolve` of the same path taken relative to the root's
 * realpath, or to the root as given, whichever holds it lexically; a path
 * under neither is refused. Not for requests: a request is relative, and
 * `safeResolve` refuses an absolute one (#3422).
 */
export function safeResolveHeld(root: string, path: string): string | null {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const canonicalRoot = safeResolve(root, ".");
  if (!canonicalRoot) return null;
  for (const base of [canonicalRoot, resolve(root)]) {
    const rel = relative(base, path);
    if (rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..")) return safeResolve(root, rel || ".");
  }
  return null;
}

/**
 * Resolve a path the caller may read or write: inside the brain root only.
 *
 * Containment exists so a tool argument cannot wander into `~/.ssh`. It once
 * also let output land under the system temp directory, for intermediates
 * that do not belong in the knowledge base. That space is now the brain's own
 * scratch area (`SCRATCH_DIR`, #310): inside the root, so the UI can open
 * what lands there, and gitignored and pruned, so it is never canonical. A
 * write into it goes through `ensureScratch`.
 */
export function resolveWritable(root: string, relPath: string): string | null {
  return safeResolve(root, relPath);
}

/**
 * A write refused on purpose: the target's entry is a link or a directory,
 * the name is taken and may not be replaced, or its directory is no longer
 * the directory it was. Callers turn these into usage errors; anything else
 * a write throws (ENOSPC, EACCES, ...) is an internal failure and stays one.
 */
export class WriteRefusedError extends Error {
  /** `EEXIST` when the name is taken and may not be replaced. */
  readonly code: "EEXIST" | undefined;
  constructor(message: string, code?: "EEXIST") {
    super(message);
    this.name = "WriteRefusedError";
    this.code = code;
  }
}

/** The mode a replaced regular file keeps. */
export function modeOf(existing: Stats | undefined): number | undefined {
  return existing?.isFile() ? existing.mode & 0o7777 : undefined;
}

/** Create and fill `tmp`, exactly `mode` (past the umask); a failed write removes it. */
export function writeExclusive(tmp: string, data: string | Uint8Array, mode: number | undefined): void {
  const fd = openSync(tmp, "wx", mode);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
}

/** `abs` under its directory's `realpath`. */
export function inCanonicalDir(abs: string): string {
  return join(realpathSync(dirname(abs)), basename(abs));
}

/** `beforePublish` runs after staging; a throw abandons the write. */
export interface WriteFileSafelyOptions {
  replace?: boolean;
  mode?: number;
  beforePublish?: () => void;
}

/**
 * Write into a directory the caller resolved (canonical, contained), never
 * through a link or into a hard-linked inode: the entry may not be a symlink
 * or directory; the bytes go to an exclusive random sibling, published once
 * the directory is re-verified as itself. The target is untouched or wholly
 * replaced, keeping its mode unless `mode` is given. `replace: false` links
 * the sibling (refusing any existing entry, EEXIST), then removes it. The
 * directory can still change before publication, as for any path-based
 * write. Scratch has `writeScratchFile`; every other user document or
 * caller-given output uses this (`tests/document-writes.test.ts`).
 */
export function writeFileSafely(
  abs: string,
  data: string | Uint8Array,
  { replace = true, mode, beforePublish }: WriteFileSafelyOptions = {},
): void {
  const parent = dirname(abs);
  mkdirSync(parent, { recursive: true });
  const genuine = (): boolean => {
    try {
      return realpathSync(parent) === parent && lstatSync(parent).isDirectory();
    } catch {
      return false;
    }
  };
  const swapped = () =>
    new WriteRefusedError(`${parent} is not a directory of its own; refusing to write ${basename(abs)} there`);
  if (!genuine()) throw swapped();
  const entry = lstatSync(abs, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw new WriteRefusedError(`${abs} is a symlink; refusing to write through it`);
  if (entry?.isDirectory()) throw new WriteRefusedError(`EISDIR: ${abs} is a directory`);
  const taken = () => new WriteRefusedError(`EEXIST: ${abs} already exists`, "EEXIST");
  if (entry && !replace) throw taken();
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeExclusive(tmp, data, mode ?? (replace ? modeOf(entry) : undefined));
  try {
    beforePublish?.();
    if (!genuine()) throw swapped();
    const now = lstatSync(abs, { throwIfNoEntry: false });
    if (now?.isSymbolicLink()) throw new WriteRefusedError(`${abs} is a symlink; refusing to write through it`);
    if (now?.isDirectory()) throw new WriteRefusedError(`EISDIR: ${abs} is a directory`);
    if (now && !replace) throw taken();
    if (replace) renameSync(tmp, abs);
    else {
      try { linkSync(tmp, abs); }
      catch (error) {
        throw (error as NodeJS.ErrnoException).code === "EEXIST" ? taken() : error;
      }
      rmSync(tmp, { force: true });
    }
  } catch (error) {
    if (genuine()) rmSync(tmp, { force: true });
    throw error;
  }
}
