import { realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/**
 * Resolve a relative path and verify it stays inside `root`, following
 * symlinks (realpath) so a symlink inside the repo can't escape it.
 * The trailing-slash comparison rejects sibling-prefix paths like
 * `../brain-other/x.md` that a bare startsWith(root) would accept.
 * Returns the canonical absolute path, or null if the path escapes.
 */
export function safeResolve(root: string, relPath: string): string | null {
  const rootReal = realpathSync(resolve(root));
  const fullPath = resolve(rootReal, relPath);
  if (!fullPath.startsWith(rootReal + "/") && fullPath !== rootReal) return null;
  // Canonicalize through symlinks. When the target (or a stretch of its
  // parents) doesn't exist yet, canonicalize the nearest EXISTING ancestor and
  // re-append the missing tail — a purely lexical fallback would let a
  // symlinked parent directory smuggle a to-be-created file outside the root.
  let existing = fullPath;
  const tail: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      tail.unshift(basename(existing));
      const parent = dirname(existing);
      // The loop always terminates at rootReal (it exists), but guard the
      // filesystem root anyway.
      if (parent === existing) return null;
      existing = parent;
      continue;
    }
    const candidate = tail.length > 0 ? join(real, ...tail) : real;
    if (!candidate.startsWith(rootReal + "/") && candidate !== rootReal) {
      return null;
    }
    return candidate;
  }
}
