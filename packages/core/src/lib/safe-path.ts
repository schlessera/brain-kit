import { randomBytes } from "crypto";
import { closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, readlinkSync, renameSync, rmSync, writeSync } from "fs";
import type { Stats } from "fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";

/**
 * Resolve a relative path and verify it stays inside `root`, following
 * symlinks (realpath) so a symlink inside the repo can't escape it.
 * The trailing-slash comparison rejects sibling-prefix paths like
 * `../brain-other/x.md` that a bare startsWith(root) would accept.
 * Returns the canonical absolute path, or null if the path escapes (or the
 * root itself does not exist).
 */
export function safeResolve(root: string, relPath: string): string | null {
  // A NUL byte would make the later fs call throw ERR_INVALID_ARG_VALUE —
  // reject it as a containment failure, not a deferred TypeError.
  if (relPath.includes("\0")) return null;

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }
  // Separator-aware containment check (backslash paths on Windows).
  const contains = (p: string) => p === rootReal || p.startsWith(rootReal + sep);
  const fullPath = resolve(rootReal, relPath);
  if (!contains(fullPath)) return null;
  // Canonicalize through symlinks. When the target (or a stretch of its
  // parents) doesn't exist yet, canonicalize the nearest EXISTING ancestor and
  // re-append the missing tail — a purely lexical fallback would let a
  // symlinked parent directory smuggle a to-be-created file outside the root.
  let existing = fullPath;
  const tail: string[] = [];
  // Symlink-hop budget: a dangling-link CYCLE (a→b, b→a) throws in realpath
  // but resolves link-by-link here — bound it like the kernel does.
  let hops = 0;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      // realpath failed: either the entry is genuinely absent, or it is a
      // DANGLING symlink (exists, target missing). The two are different
      // security cases — a write through a dangling link is created AT THE
      // LINK TARGET, so it must be resolved and re-checked, never treated as
      // "doesn't exist yet".
      let linkTarget: string | null = null;
      try {
        if (lstatSync(existing).isSymbolicLink()) {
          linkTarget = readlinkSync(existing);
        }
      } catch {
        // lstat failed too → the entry really doesn't exist.
      }
      if (linkTarget !== null) {
        if (++hops > 40) return null;
        const resolvedTarget = isAbsolute(linkTarget)
          ? resolve(linkTarget)
          : resolve(dirname(existing), linkTarget);
        // Re-enter containment checking with the link's target substituted in.
        const rejoined = tail.length > 0 ? join(resolvedTarget, ...tail) : resolvedTarget;
        if (!contains(rejoined)) return null;
        existing = rejoined;
        tail.length = 0;
        continue;
      }
      tail.unshift(basename(existing));
      const parent = dirname(existing);
      // The loop always terminates at rootReal (it exists), but guard the
      // filesystem root anyway.
      if (parent === existing) return null;
      existing = parent;
      continue;
    }
    const candidate = tail.length > 0 ? join(real, ...tail) : real;
    if (!contains(candidate)) return null;
    return candidate;
  }
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
export function resolveWritable(root: string, relOrAbs: string): string | null {
  return safeResolve(root, relOrAbs);
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
