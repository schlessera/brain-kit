import { realpathSync } from "fs";
import { resolve } from "path";

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
  // Canonicalize through symlinks when the target exists
  try {
    const real = realpathSync(fullPath);
    if (!real.startsWith(rootReal + "/") && real !== rootReal) return null;
    return real;
  } catch {
    // Target doesn't exist yet — the lexical check above still holds
    return fullPath;
  }
}
