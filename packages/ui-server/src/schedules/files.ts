/**
 * Definition-file publication and retirement inside the canonical brain root.
 *
 * Every directory component is checked with lstat (no symlink anywhere) and
 * its inode identity is re-verified after each write, so a rename or symlink
 * swap between check and use fails closed instead of escaping the root.
 * Publication never replaces an existing file: it links a synced private
 * temporary file into place, which fails when the name is taken.
 */
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { DEFINITIONS_DIR, MAX_DEFINITION_FILE_BYTES, RETIRED_DIR } from "./definition.js";

export class ScheduleFileConflictError extends Error {}
export class ScheduleContainmentError extends Error {}

interface DirIdentity { path: string; dev: number; ino: number }

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Walk (and optionally create) a relative directory chain under the root, refusing symlinks. */
async function directoryChain(root: string, relative: string, create: boolean): Promise<DirIdentity[] | null> {
  const chain: DirIdentity[] = [];
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new ScheduleContainmentError("Brain root is not a directory");
  chain.push({ path: root, dev: rootInfo.dev, ino: rootInfo.ino });
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      if (!create) return null;
      try { await mkdir(current, { mode: 0o755 }); }
      catch (mkdirError) { if (errno(mkdirError) !== "EEXIST") throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ScheduleContainmentError("Schedule directory is not a contained directory");
    chain.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return chain;
}

async function assertChain(chain: DirIdentity[]): Promise<void> {
  for (const entry of chain) {
    const info = await lstat(entry.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino)
      throw new ScheduleContainmentError("Schedule directory changed during a file operation");
  }
}

/** Read a regular, single-link file without following a symlink; null when absent. */
async function readContained(path: string): Promise<Buffer | null> {
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
    return await handle.readFile();
  } finally { await handle.close(); }
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
  /** Remove this host's interrupted temporaries for one task. */
  reapTemporaries(id: string): Promise<void>;
}

export function createScheduleFiles(root: string): ScheduleFiles {
  const definitions = (id: string) => join(root, DEFINITIONS_DIR, `${id}.md`);
  const retired = (id: string) => join(root, RETIRED_DIR, `${id}.md`);

  async function reapTemporaries(id: string): Promise<void> {
    const chain = await directoryChain(root, DEFINITIONS_DIR, false);
    if (!chain) return;
    const prefix = `.${id}.md.`;
    for (const name of await readdir(chain.at(-1)!.path)) {
      if (!name.startsWith(prefix) || !/^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) continue;
      const path = join(chain.at(-1)!.path, name);
      if ((await lstat(path)).isFile()) await unlink(path);
    }
  }

  return {
    async publish(id, text) {
      const bytes = Buffer.from(text, "utf8");
      const chain = (await directoryChain(root, DEFINITIONS_DIR, true))!;
      const dir = chain.at(-1)!.path, final = definitions(id);
      const existing = await readContained(final);
      if (existing) {
        if (!existing.equals(bytes)) throw new ScheduleFileConflictError("A different definition file already exists");
        await assertChain(chain);
        return;
      }
      const temporary = join(dir, `.${id}.md.${crypto.randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      let ino = -1;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        ino = (await handle.stat()).ino;
      } finally { await handle.close(); }
      try {
        await assertChain(chain);
        try { await link(temporary, final); }
        catch (error) {
          if (errno(error) !== "EEXIST") throw error;
          const raced = await readContained(final);
          if (!raced?.equals(bytes)) throw new ScheduleFileConflictError("A different definition file already exists");
        }
      } finally {
        await unlink(temporary).catch(() => {});
      }
      await syncDirectory(dir);
      await assertChain(chain);
      const published = await lstat(final);
      if (!published.isFile() || published.isSymbolicLink()) throw new ScheduleContainmentError("Published definition is not a regular file");
      if (published.ino !== ino && !(await readContained(final))?.equals(bytes))
        throw new ScheduleFileConflictError("Published definition changed");
    },

    async retire(id, text) {
      const bytes = Buffer.from(text, "utf8");
      const active = await directoryChain(root, DEFINITIONS_DIR, false);
      const current = active ? await readContained(definitions(id)) : null;
      const archive = (await directoryChain(root, RETIRED_DIR, true))!;
      if (!current) {
        // Nothing active remains. Retirement is complete either way; matching
        // data cannot revive a cancelled ID.
        await assertChain(archive);
        return true;
      }
      if (!current.equals(bytes)) return false;
      try { await link(definitions(id), retired(id)); }
      catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        if (!(await readContained(retired(id)))?.equals(bytes)) return false;
      }
      await syncDirectory(archive.at(-1)!.path);
      await assertChain(active!);
      // Another process may have completed the same retirement concurrently.
      await unlink(definitions(id)).catch((error) => { if (errno(error) !== "ENOENT") throw error; });
      await syncDirectory(active!.at(-1)!.path);
      await assertChain(archive);
      return true;
    },

    async readActive(id) {
      const chain = await directoryChain(root, DEFINITIONS_DIR, false);
      if (!chain) return null;
      const bytes = await readContained(definitions(id));
      await assertChain(chain);
      return bytes;
    },

    reapTemporaries,
  };
}
