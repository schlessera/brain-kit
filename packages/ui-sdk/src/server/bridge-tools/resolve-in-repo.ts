import { lstatSync, realpathSync, readlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";

/**
 * Resolve a repo-relative path without allowing a symlink to escape the repo.
 *
 * Keep these semantics in lockstep with the reference implementation at
 * `packages/core/src/lib/safe-path.ts` (`safeResolve`). The SDK deliberately
 * ports that implementation instead of depending on `@schlessera/brain`.
 */
export function resolveInRepo(root: string, relPath: string): string | null {
  if (relPath.includes("\0") || isAbsolute(relPath)) return null;

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }

  const contains = (path: string) =>
    path === rootReal || path.startsWith(rootReal + sep);
  const fullPath = resolve(rootReal, relPath);
  if (!contains(fullPath)) return null;

  let existing = fullPath;
  const tail: string[] = [];
  let hops = 0;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      let linkTarget: string | null = null;
      try {
        if (lstatSync(existing).isSymbolicLink()) {
          linkTarget = readlinkSync(existing);
        }
      } catch {
        // lstat failed too: this entry is genuinely absent.
      }
      if (linkTarget !== null) {
        if (++hops > 40) return null;
        const resolvedTarget = isAbsolute(linkTarget)
          ? resolve(linkTarget)
          : resolve(dirname(existing), linkTarget);
        const rejoined =
          tail.length > 0 ? join(resolvedTarget, ...tail) : resolvedTarget;
        if (!contains(rejoined)) return null;
        existing = rejoined;
        tail.length = 0;
        continue;
      }
      tail.unshift(basename(existing));
      const parent = dirname(existing);
      if (parent === existing) return null;
      existing = parent;
      continue;
    }
    const candidate = tail.length > 0 ? join(real, ...tail) : real;
    if (!contains(candidate)) return null;
    return candidate;
  }
}
