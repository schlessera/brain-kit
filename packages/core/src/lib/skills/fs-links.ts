/**
 * Symlink helpers shared by skill sync and the claude and pi emitters.
 *
 * Ports the platform handling of `scripts/hooks/sync-skills`: standard symlinks
 * on Unix/WSL/macOS, directory-junction fallback on native Windows. Unlike the
 * shell original (which shells out to `cmd.exe /c mklink /J`), we use Node's
 * built-in junction support (`symlinkSync(absTarget, link, "junction")`) — same
 * NTFS junction, no child process. See sync.ts fidelity notes.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

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

/** What {@link linkSkillsInto} did, by skill or entry name. */
export interface LinkSkillsResult {
  /** Linked, or re-pointed from an old target, this run. */
  linked: string[];
  /** Symlinks in the directory that name no wanted skill, removed. */
  pruned: string[];
  /** Left alone because a real file or directory occupies the path. */
  skipped: string[];
  /** Could not be linked. */
  failed: string[];
}

/**
 * Keep `dir` holding one symlink per entry, `<dir>/<name>` → `target`: a link
 * already pointing at its target stays, one pointing elsewhere is re-pointed,
 * a real file or directory at the path is never clobbered, and any other
 * symlink in `dir` is pruned. Real directories are never touched.
 */
export function linkSkillsInto(dir: string, entries: { name: string; target: string }[]): LinkSkillsResult {
  const result: LinkSkillsResult = { linked: [], pruned: [], skipped: [], failed: [] };
  mkdirSync(dir, { recursive: true });

  for (const { name, target } of entries) {
    const link = join(dir, name);
    if (isSymlink(link)) {
      if (normalizeLinkTarget(readLink(link) ?? "") === normalizeLinkTarget(target)) continue; // already correct
      rmSync(link); // old target — re-point
    } else if (existsSync(link)) {
      result.skipped.push(name);
      continue;
    }
    if (makeLink(target, link, true)) result.linked.push(name);
    else result.failed.push(name);
  }

  // Prune stale symlinks (removed or renamed skills, old package paths).
  const want = new Set(entries.map((e) => e.name));
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (isSymlink(p) && !want.has(entry)) {
      rmSync(p);
      result.pruned.push(entry);
    }
  }
  return result;
}
