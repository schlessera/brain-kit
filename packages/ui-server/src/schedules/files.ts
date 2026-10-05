/**
 * Definition-file publication and retirement inside the canonical brain root.
 *
 * Each directory is opened component by component with O_NOFOLLOW, and every
 * later operation is anchored to that open directory: on Linux through the
 * `/proc/self/fd/<fd>/<name>` magic link, which resolves to the directory the
 * descriptor holds even if a path component is renamed or swapped for a
 * symlink. So a swap between check and use cannot redirect a write outside
 * the root. Without procfs the same operations run on the verified paths and
 * re-check each directory's identity afterwards (check-then-use, detected).
 *
 * Publication never replaces an existing file: it links a synced private
 * temporary file into place, which fails when the name is taken. Retirement
 * moves only the exact file identity whose bytes were verified.
 */
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { DEFINITIONS_DIR, MAX_DEFINITION_FILE_BYTES, RETIRED_DIR } from "./definition.js";

export class ScheduleFileConflictError extends Error {}
export class ScheduleContainmentError extends Error {}

/** Interrupted temporaries older than this belong to a writer that stopped. */
export const TEMPORARY_REAP_AGE_MS = 60 * 60_000;
const ANCHORED = process.platform === "linux" && existsSync("/proc/self/fd");
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface Directory {
  handle: FileHandle;
  path: string;
  dev: number;
  ino: number;
  /** A path for `name` inside exactly this open directory. */
  at(name: string): string;
}

async function openDirectory(path: string, display: string): Promise<Directory> {
  let handle: FileHandle;
  try { handle = await open(path, DIRECTORY_FLAGS); }
  catch (error) {
    if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR") throw new ScheduleContainmentError("Schedule directory is not a contained directory");
    throw error;
  }
  const info = await handle.stat();
  return {
    handle, path: display, dev: info.dev, ino: info.ino,
    at: (name) => ANCHORED ? `/proc/self/fd/${handle.fd}/${name}` : join(display, name),
  };
}

/** Open (and optionally create) a relative directory chain under the root. */
async function directoryChain(root: string, relative: string, create: boolean): Promise<Directory[] | null> {
  const chain: Directory[] = [];
  try {
    chain.push(await openDirectory(root, root));
    for (const segment of relative.split("/")) {
      const parent = chain.at(-1)!;
      const target = parent.at(segment), display = join(parent.path, segment);
      try { chain.push(await openDirectory(target, display)); continue; }
      catch (error) { if (errno(error) !== "ENOENT") throw error; }
      if (!create) { await closeChain(chain); return null; }
      try { await mkdir(target, { mode: 0o755 }); }
      catch (error) { if (errno(error) !== "EEXIST") throw error; }
      chain.push(await openDirectory(target, display));
    }
    return chain;
  } catch (error) {
    await closeChain(chain);
    throw error;
  }
}

async function closeChain(chain: Directory[] | null): Promise<void> {
  for (const entry of chain ?? []) await entry.handle.close().catch(() => {});
}

/** Path-mode fallback only: the paths must still name the opened directories. */
async function assertChain(chain: Directory[]): Promise<void> {
  if (ANCHORED) return;
  for (const entry of chain) {
    const info = await lstat(entry.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino)
      throw new ScheduleContainmentError("Schedule directory changed during a file operation");
  }
}

/** Open a bounded regular file without following a symlink; null when absent. */
async function openContained(path: string): Promise<{ bytes: Buffer; ino: number } | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    if (errno(error) === "ELOOP") throw new ScheduleContainmentError("Definition file is a symlink");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_DEFINITION_FILE_BYTES) throw new ScheduleContainmentError("Definition is not a bounded regular file");
    return { bytes: await handle.readFile(), ino: info.ino };
  } finally { await handle.close(); }
}

async function inode(path: string): Promise<number | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? info.ino : null;
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Refuse a target whose existing path components include a symlink. Absent
 * components are fine: the exact path is what a tool may later access, where
 * containment is checked again at the actual file access.
 */
export async function assertTargetContained(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of target.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ScheduleContainmentError("Target path contains a symlink");
    } catch (error) {
      if (errno(error) === "ENOENT") return;
      throw error;
    }
  }
}

export interface ScheduleFiles {
  /** Publish exact bytes as definitions/<id>.md; idempotent for identical bytes. */
  publish(id: string, bytes: string): Promise<void>;
  /** Move unchanged bytes to retired/<id>.md. Returns false when the active file drifted. */
  retire(id: string, bytes: string): Promise<boolean>;
  /** The active definition bytes, or null when absent. */
  readActive(id: string): Promise<Buffer | null>;
  /** Remove interrupted temporaries for one task older than `olderThan` (ms epoch). */
  reapTemporaries(id: string, olderThan: number): Promise<void>;
}

export function createScheduleFiles(root: string): ScheduleFiles {
  const name = (id: string) => `${id}.md`;

  return {
    async publish(id, text) {
      const bytes = Buffer.from(text, "utf8");
      const chain = (await directoryChain(root, DEFINITIONS_DIR, true))!;
      try {
        const dir = chain.at(-1)!, final = dir.at(name(id));
        const existing = await openContained(final);
        if (existing) {
          if (!existing.bytes.equals(bytes)) throw new ScheduleFileConflictError("A different definition file already exists");
          await assertChain(chain);
          return;
        }
        await assertChain(chain);
        const temporary = dir.at(`.${id}.md.${crypto.randomUUID()}.tmp`);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        try {
          try { await link(temporary, final); }
          catch (error) {
            if (errno(error) !== "EEXIST") throw error;
            const raced = await openContained(final);
            if (!raced?.bytes.equals(bytes)) throw new ScheduleFileConflictError("A different definition file already exists");
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
        await dir.handle.sync();
        await assertChain(chain);
        // Same inode or not, only the approved bytes count as published.
        const published = await openContained(final);
        if (!published?.bytes.equals(bytes)) throw new ScheduleFileConflictError("Published definition changed");
      } finally { await closeChain(chain); }
    },

    async retire(id, text) {
      const bytes = Buffer.from(text, "utf8");
      const active = await directoryChain(root, DEFINITIONS_DIR, false);
      let archive: Directory[] | null = null;
      try {
        archive = (await directoryChain(root, RETIRED_DIR, true))!;
        const source = active ? active.at(-1)!.at(name(id)) : null;
        // Finish a retirement interrupted after its claiming rename: archive a
        // claimed verified file, or put back anything else.
        if (active) {
          const dir = active.at(-1)!, prefix = `.${id}.md.`;
          for (const entry of await readdir(dir.at("."))) {
            if (!entry.startsWith(prefix) || !/^[0-9a-f-]{36}\.retiring$/.test(entry.slice(prefix.length))) continue;
            const claim = dir.at(entry), held = await openContained(claim);
            if (!held) continue;
            const target = held.bytes.equals(bytes) ? archive.at(-1)!.at(name(id)) : source!;
            try { await link(claim, target); }
            catch (error) {
              if (errno(error) !== "EEXIST" || !(await openContained(target))?.bytes.equals(held.bytes)) continue;
            }
            await unlink(claim);
          }
        }
        const current = source ? await openContained(source) : null;
        // Nothing active remains. Retirement is complete either way; matching
        // data cannot revive a cancelled ID.
        if (!current) { await assertChain(archive); return true; }
        if (!current.bytes.equals(bytes)) return false;
        const activeDir = active!.at(-1)!, archiveDir = archive.at(-1)!;
        const destination = archiveDir.at(name(id));
        // Take ownership of whatever now sits at the active path with one
        // atomic rename, then check it is the verified file. A replacement
        // written after the check is put back, never deleted.
        const claimed = activeDir.at(`.${id}.md.${crypto.randomUUID()}.retiring`);
        try { await rename(source!, claimed); }
        catch (error) {
          if (errno(error) === "ENOENT") return true; // Another retirer finished first.
          throw error;
        }
        if (await inode(claimed) !== current.ino) {
          await link(claimed, source!).then(() => unlink(claimed)).catch(() => {});
          return false;
        }
        try { await link(claimed, destination); }
        catch (error) {
          if (errno(error) !== "EEXIST") throw error;
          if (!(await openContained(destination))?.bytes.equals(bytes)) {
            await link(claimed, source!).then(() => unlink(claimed)).catch(() => {});
            return false;
          }
        }
        await archiveDir.handle.sync();
        await unlink(claimed);
        await activeDir.handle.sync();
        await assertChain(active!);
        await assertChain(archive);
        return true;
      } finally { await closeChain(active); await closeChain(archive); }
    },

    async readActive(id) {
      const chain = await directoryChain(root, DEFINITIONS_DIR, false);
      if (!chain) return null;
      try {
        const file = await openContained(chain.at(-1)!.at(name(id)));
        await assertChain(chain);
        return file?.bytes ?? null;
      } finally { await closeChain(chain); }
    },

    async reapTemporaries(id, olderThan) {
      const chain = await directoryChain(root, DEFINITIONS_DIR, false);
      if (!chain) return;
      try {
        const dir = chain.at(-1)!, prefix = `.${id}.md.`;
        for (const entry of await readdir(dir.at("."))) {
          if (!entry.startsWith(prefix) || !/^[0-9a-f-]{36}\.tmp$/.test(entry.slice(prefix.length))) continue;
          const info = await lstat(dir.at(entry)).catch(() => null);
          // Only a stopped writer's file: a live publisher's temporary is young.
          if (info?.isFile() && info.mtimeMs < olderThan) await unlink(dir.at(entry)).catch(() => {});
        }
      } finally { await closeChain(chain); }
    },
  };
}
