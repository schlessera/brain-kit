/**
 * Symlink helpers shared by skill sync + the claude emitter.
 *
 * Ports the platform handling of `scripts/hooks/sync-skills`: standard symlinks
 * on Unix/WSL/macOS, directory-junction fallback on native Windows. Unlike the
 * shell original (which shells out to `cmd.exe /c mklink /J`), we use Node's
 * built-in junction support (`symlinkSync(absTarget, link, "junction")`) — same
 * NTFS junction, no child process. See sync.ts fidelity notes.
 */

import { lstatSync, readlinkSync, symlinkSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";

/** True when the path exists and is itself a symlink (does not follow). */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Read a symlink's raw target, or null if it is not a readable symlink. */
export function readLink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

/** Normalize a link target for cross-platform comparison (backslashes → slashes). */
export function normalizeLinkTarget(target: string): string {
  return target.replace(/\\/g, "/");
}

/**
 * Create a symlink `link` → `target`. On native Windows a directory link falls
 * back to a junction (which needs an absolute target). Returns whether it
 * succeeded — callers surface a warning on false, never throw (best-effort,
 * exactly like the shell original).
 */
export function makeLink(target: string, link: string, isDir: boolean): boolean {
  try {
    symlinkSync(target, link, isDir ? "dir" : "file");
    return true;
  } catch {
    if (process.platform === "win32" && isDir) {
      try {
        const abs = isAbsolute(target) ? target : resolve(dirname(link), target);
        symlinkSync(abs, link, "junction");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
