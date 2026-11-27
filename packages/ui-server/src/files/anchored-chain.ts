/**
 * An anchored chain of directory handles below a root, for writers that must
 * not follow a symlink planted at any component (#4760).
 *
 * Each component is opened with `O_DIRECTORY | O_NOFOLLOW`, and on Linux the
 * next one through `/proc/self/fd/<fd>/<name>`, which resolves to the
 * directory the open descriptor holds even if a path component is renamed or
 * swapped for a symlink. Without procfs the chain uses the verified paths and
 * `assertChain` re-checks every directory's identity afterwards.
 *
 * A refusal is the caller's own error: `refuse` is called with
 * `not-contained` when a component is a symlink or not a directory, and with
 * `changed` when a path-mode re-check finds a different directory.
 */
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const ANCHORED = process.platform === "linux" && existsSync("/proc/self/fd");
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type ChainRefusal = "not-contained" | "changed";
export type RefuseChain = (reason: ChainRefusal) => Error;

export function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface Directory {
  handle: FileHandle;
  path: string;
  dev: number;
  ino: number;
  /** A path for `name` inside exactly this open directory. */
  at(name: string): string;
}

async function openDirectory(path: string, display: string, refuse: RefuseChain): Promise<Directory> {
  let handle: FileHandle;
  try { handle = await open(path, DIRECTORY_FLAGS); }
  catch (error) {
    if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR") throw refuse("not-contained");
    throw error;
  }
  const info = await handle.stat();
  return {
    handle, path: display, dev: info.dev, ino: info.ino,
    at: (name) => ANCHORED ? `/proc/self/fd/${handle.fd}/${name}` : join(display, name),
  };
}

/**
 * Open the root and each component of `relative` below it, creating a missing
 * component (mode `0o755`) when `create` is set. Returns `null` when a
 * component is missing and `create` is off. Every handle it opened is closed
 * before it returns `null` or throws.
 */
export async function directoryChain(root: string, relative: string, create: boolean, refuse: RefuseChain): Promise<Directory[] | null> {
  const chain: Directory[] = [];
  try {
    chain.push(await openDirectory(root, root, refuse));
    for (const segment of relative.split("/")) {
      const parent = chain.at(-1)!;
      const target = parent.at(segment), display = join(parent.path, segment);
      try { chain.push(await openDirectory(target, display, refuse)); continue; }
      catch (error) { if (errno(error) !== "ENOENT") throw error; }
      if (!create) { await closeChain(chain); return null; }
      try { await mkdir(target, { mode: 0o755 }); }
      catch (error) { if (errno(error) !== "EEXIST") throw error; }
      chain.push(await openDirectory(target, display, refuse));
    }
    return chain;
  } catch (error) {
    await closeChain(chain);
    throw error;
  }
}

export async function closeChain(chain: Directory[] | null): Promise<void> {
  for (const entry of chain ?? []) await entry.handle.close().catch(() => {});
}

/** Path-mode fallback only: the paths must still name the opened directories. */
export async function assertChain(chain: Directory[], refuse: RefuseChain): Promise<void> {
  if (ANCHORED) return;
  for (const entry of chain) {
    const info = await lstat(entry.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino)
      throw refuse("changed");
  }
}
