import { randomBytes } from "crypto";
import { lstatSync, mkdirSync, realpathSync, readlinkSync, renameSync, rmSync, writeFileSync } from "fs";
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
 * Write a file whose directory the caller has already resolved (canonical,
 * contained) without ever writing through a link or into an inode a hard
 * link shares: the target's own entry may not be a symlink or a directory,
 * and the bytes go to a random temporary sibling created exclusively, then
 * renamed onto the name once the directory is re-verified to be exactly
 * itself (`realpath` equal, a directory, not a link put in its place). A
 * rename replaces the directory entry rather than writing through it.
 * `replace: false` refuses an existing file (EEXIST). The one syscall between
 * the verification and the rename remains, as it does for any path-based
 * write in Node. The scratch area has its own primitive on top of the same
 * shape (`writeScratchFile`); this is for every other write of caller-given
 * output (`render --out`, `image --out`, the OKF export).
 */
export function writeFileSafely(
  abs: string,
  data: string | Uint8Array,
  { replace = true }: { replace?: boolean } = {},
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
  const swapped = () => new Error(`${parent} is not a directory of its own; refusing to write ${basename(abs)} there`);
  if (!genuine()) throw swapped();
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { flag: "wx" });
  try {
    if (!genuine()) throw swapped();
    const entry = lstatSync(abs, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error(`${abs} is a symlink; refusing to write through it`);
    if (entry?.isDirectory()) throw new Error(`EISDIR: ${abs} is a directory`);
    if (entry && !replace) throw new Error(`EEXIST: ${abs} already exists`);
    renameSync(tmp, abs);
  } catch (error) {
    if (genuine()) rmSync(tmp, { force: true });
    throw error;
  }
}
