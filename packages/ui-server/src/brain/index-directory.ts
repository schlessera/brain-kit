/**
 * The disposable index's directory on the host side (#1668, option B).
 *
 * Core keeps `brain.db` and its SQLite sidecars in `.brain-index/`. A governed
 * writer retains that directory with the same read-write self-bind as a
 * provider folder, so no peer can remove or replace it under a turn whose
 * private filtered index is mounted over it. Retention needs an existing,
 * unaliased directory, which the host creates before admission. Nothing in it
 * is authoritative, so creating it invents no content.
 *
 * Brains from releases before 0.44.0 still carry the old root-level copies.
 * They hold document bodies that a provider-restricted turn must not read, and
 * a loose file cannot be retained robustly, so the host deletes them at boot.
 * The index is rebuilt in the new directory, never moved.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { INDEX_DIR, LEGACY_INDEX_FAMILY } from "@schlessera/brain-common/internal/index-location";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/**
 * Create `.brain-index/` when it is missing, with the brain root's permission
 * bits so every worker identity that can write the root can write the index.
 * A server-owned directory with other bits (one a worker created under its
 * own umask in a staged view) is set back to the root's. An existing link or
 * non-directory under the name is refused, never replaced.
 */
export function ensureIndexDirectory(brain: string): void {
  const root = openSync(brain, DIRECTORY);
  try {
    const path = at(root, INDEX_DIR);
    let info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      info = lstatSync(path);
      const created = openSync(path, DIRECTORY);
      try {
        const opened = fstatSync(created);
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${INDEX_DIR} changed while it was created`);
        if (opened.uid === process.getuid?.()) fchmodSync(created, fstatSync(root).mode & 0o7777);
      } finally { closeSync(created); }
      info = lstatSync(path);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${INDEX_DIR} in the brain root is not a directory`);
    const wanted = fstatSync(root).mode & 0o7777;
    if (info.uid === process.getuid?.() && (info.mode & 0o7777) !== wanted) {
      const held = openSync(path, DIRECTORY);
      try {
        const opened = fstatSync(held);
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${INDEX_DIR} changed while its mode was checked`);
        fchmodSync(held, wanted);
      } finally { closeSync(held); }
    }
  } finally { closeSync(root); }
}

/**
 * Delete the root-level index family a release before 0.44.0 left behind.
 * Only regular files and links are removed (a link is unlinked, its target is
 * untouched); a directory under one of the names is reported and kept.
 * Returns the names removed.
 */
export function retireLegacyIndex(brain: string): { removed: string[]; kept: string[] } {
  const removed: string[] = [], kept: string[] = [];
  const root = openSync(brain, DIRECTORY);
  try {
    for (const name of LEGACY_INDEX_FAMILY) {
      const path = at(root, name), info = lstatSync(path, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() && !info.isSymbolicLink()) { kept.push(name); continue; }
      try { unlinkSync(path); removed.push(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally { closeSync(root); }
  return { removed, kept };
}
