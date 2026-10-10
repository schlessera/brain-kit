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
  /** `EEXIST` when the name is taken and may not be replaced; a caller can tell that refusal from the others. */
  readonly code: "EEXIST" | undefined;
  constructor(message: string, code?: "EEXIST") {
    super(message);
    this.name = "WriteRefusedError";
    this.code = code;
  }
}

/** The permission bits a replacement of `existing` keeps: its own, when it is a regular file. */
export function modeOf(existing: Stats | undefined): number | undefined {
  return existing?.isFile() ? existing.mode & 0o7777 : undefined;
}

/**
 * Create `tmp` exclusively and fill it. Given a `mode` (the file it replaces,
 * `modeOf`), it takes that exact mode first (opened with the mode, then
 * `fchmod` past the umask) so the bytes are never readable more widely than
 * the file they replace; without one it keeps the default mode. A failed
 * write removes `tmp` again.
 */
export function writeExclusive(tmp: string, data: string | Uint8Array, mode: number | undefined): void {
  const fd = openSync(tmp, "wx", mode);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  } catch (error) {
    // A write that fails part way (ENOSPC, EFBIG) leaves no partial file behind.
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
}

/**
 * `abs` with its directory canonicalized (`realpath`), for a caller that
 * holds a path under a root it did not canonicalize itself. The final entry
 * is left as named, so `writeFileSafely` still refuses a link there rather
 * than writing through it. The directory must exist.
 */
export function inCanonicalDir(abs: string): string {
  return join(realpathSync(dirname(abs)), basename(abs));
}

export interface WriteFileSafelyOptions {
  /** Replace an existing regular file (default), or refuse every existing entry with `EEXIST`. */
  replace?: boolean;
  /** Permission bits for the written file, instead of the replaced file's own (or the default). */
  mode?: number;
  /** Runs after staging, before publication; a throw abandons the write. */
  beforePublish?: () => void;
}

/**
 * Write a file whose directory the caller has already resolved (canonical,
 * contained) without ever writing through a link or into an inode a hard
 * link shares: the target's own entry may not be a symlink or a directory,
 * and the bytes go to a random temporary sibling created exclusively, then
 * published onto the name once the directory is re-verified to be exactly
 * itself (`realpath` equal, a directory, not a link put in its place). A
 * replacement rename changes the entry rather than writing through it. A
 * replaced regular file keeps its mode (`writeExclusive`); `mode` sets the
 * bits instead, for a new name that carries an old file's content (an
 * archive move). `beforePublish` runs once the bytes are staged, before the
 * re-verification and publication; whatever it throws abandons the write and
 * leaves the target as it was (a compare-before-replace check).
 * The target is either untouched or wholly replaced: a write that fails part
 * way (ENOSPC, EFBIG) fails on the temporary sibling, which is removed.
 * `replace: false` publishes the completed sibling with a hard link, which
 * atomically refuses every existing destination entry (EEXIST), then removes
 * the temporary name. It never replaces an entry arriving after the check.
 * The directory can still change between verification and publication, as
 * it can for any path-based write in Node. The scratch area has its own
 * primitive on top of the same shape (`writeScratchFile`); this is for every
 * other write of a user document (`brain_update`, capture, archive, sync's
 * merges and `updated` bumps, tag and hygiene rewrites) and of caller-given
 * output (`render --out`, `image --out`, the OKF export).
 * `tests/document-writes.test.ts` holds core to it.
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
  if (entry && !replace) throw new WriteRefusedError(`EEXIST: ${abs} already exists`, "EEXIST");
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeExclusive(tmp, data, mode ?? (replace ? modeOf(entry) : undefined));
  try {
    beforePublish?.();
    if (!genuine()) throw swapped();
    const now = lstatSync(abs, { throwIfNoEntry: false });
    if (now?.isSymbolicLink()) throw new WriteRefusedError(`${abs} is a symlink; refusing to write through it`);
    if (now?.isDirectory()) throw new WriteRefusedError(`EISDIR: ${abs} is a directory`);
    if (now && !replace) throw new WriteRefusedError(`EEXIST: ${abs} already exists`, "EEXIST");
    if (replace) renameSync(tmp, abs);
    else {
      try { linkSync(tmp, abs); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new WriteRefusedError(`EEXIST: ${abs} already exists`, "EEXIST");
        }
        throw error;
      }
      rmSync(tmp, { force: true });
    }
  } catch (error) {
    if (genuine()) rmSync(tmp, { force: true });
    throw error;
  }
}
