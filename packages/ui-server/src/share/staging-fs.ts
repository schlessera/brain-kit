/**
 * Descriptor-anchored filesystem operations for the share staging directory
 * (#2907), following the application route's no-follow chain (`openTarget`,
 * `packages/ui-server/src/brain/application.ts`).
 *
 * Every staging mutation goes through a directory descriptor opened with
 * `O_NOFOLLOW`, starting from the brain's canonical root, so neither a link in
 * place when staging starts nor one swapped in between a check and the system
 * call can redirect a write, a publication or a removal into other content.
 * The brain root itself may be a link; every component below it, from
 * `.brain-ui` down to each staged entry, must be a real directory, which is
 * the boundary inbox cleanup and the TTL prune already enforced by pathname.
 */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";

/** The staging directory, or a component on its way, is a link or changed while it was in use. */
export class StagingTopologyError extends Error {
  constructor(message = "Share staging directory must not traverse a symlink") {
    super(message);
    this.name = "StagingTopologyError";
  }
}

export interface StagingDirectory { fd: number; path: string; dev: number; ino: number }

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A name inside an open directory, resolved by the kernel from its descriptor. */
export const at = (dir: StagingDirectory, name: string) => `/proc/self/fd/${dir.fd}/${name}`;

function validName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new StagingTopologyError("Invalid staging entry name");
  return name;
}

/** Open a directory without following a link in its final component. */
function openDirectory(path: string, visible: string): StagingDirectory {
  let fd: number;
  try { fd = openSync(path, directoryFlags); }
  catch (error) {
    if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR") throw new StagingTopologyError();
    throw error;
  }
  const info = fstatSync(fd);
  return { fd, path: visible, dev: info.dev, ino: info.ino };
}

/** The staging root's open chain, from the brain's canonical root down. */
export interface StagingRoot {
  /** The staging directory itself. */
  readonly dir: StagingDirectory;
  /** Refuses unless every component is still the directory that was opened, unlinked, at its visible path. */
  verify(): void;
  /** Flush the staging directory and `.brain-ui` entries to disk. */
  sync(): void;
  close(): void;
}

/**
 * Open `.brain-ui/inbox` below the brain's canonical root without following
 * any link. With `create`, missing components are created in place; without
 * it, a missing component yields `null` (nothing is staged). A link, or a
 * non-directory where a component should be, refuses. `mode` applies to the
 * components this call creates.
 */
export function openStagingRoot(brainPath: string, create: boolean, mode = 0o755): StagingRoot | null {
  const brain = realpathSync(brainPath);
  const chain: StagingDirectory[] = [];
  try {
    chain.push(openDirectory(brain, brain));
    for (const part of SHARE_STAGING_DIR.split("/")) {
      const parent = chain.at(-1)!, visible = join(parent.path, part);
      try { chain.push(openDirectory(at(parent, part), visible)); }
      catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        if (!create) { for (const dir of chain.reverse()) closeSync(dir.fd); return null; }
        try { mkdirSync(at(parent, part), { mode }); }
        catch (mkdirError) { if (errno(mkdirError) !== "EEXIST") throw mkdirError; }
        chain.push(openDirectory(at(parent, part), visible));
      }
    }
  } catch (error) { for (const dir of chain.reverse()) closeSync(dir.fd); throw error; }
  return {
    dir: chain.at(-1)!,
    verify() { for (const dir of chain) verifyDirectory(dir, dir.path); },
    sync() { for (const dir of chain.slice(-2)) fsyncSync(dir.fd); },
    close() { for (const dir of chain.splice(0).reverse()) closeSync(dir.fd); },
  };
}

/** Refuses unless `path` names `dir` itself as a real directory, without following a link. */
function verifyDirectory(dir: StagingDirectory, path: string): void {
  let info;
  try { info = lstatSync(path); }
  catch { throw new StagingTopologyError("A staging directory changed while it was in use"); }
  if (!info.isDirectory() || info.dev !== dir.dev || info.ino !== dir.ino)
    throw new StagingTopologyError("A staging directory changed while it was in use");
}

/** Create a new directory inside `parent`, exclusively, and open it. */
export function makeDirectory(parent: StagingDirectory, name: string, mode = 0o755): StagingDirectory {
  mkdirSync(at(parent, validName(name)), { mode });
  return openDirectory(at(parent, name), join(parent.path, name));
}

/** Open the existing directory `name` inside `parent`; a link or a non-directory refuses. */
export function openEntry(parent: StagingDirectory, name: string): StagingDirectory {
  return openDirectory(at(parent, validName(name)), join(parent.path, name));
}

/** Refuses unless `parent`'s entry `name` is still the directory `dir`. */
export function verifyEntry(parent: StagingDirectory, name: string, dir: StagingDirectory): void {
  verifyDirectory(dir, at(parent, validName(name)));
}

/** Create a new file inside `dir`: never follows a link, never truncates an existing entry. */
export async function writeExclusive(dir: StagingDirectory, name: string, bytes: Uint8Array | string): Promise<void> {
  const file = await open(at(dir, validName(name)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { await file.writeFile(bytes); } finally { await file.close(); }
}

/**
 * Rename the directory `from` to the absent name `to`, both inside `parent`,
 * and confirm what was published is still `moved`. A link or an unrelated
 * directory under either name refuses rather than being followed or replaced.
 */
export function publishDirectory(parent: StagingDirectory, from: string, to: string, moved: StagingDirectory): void {
  verifyEntry(parent, from, moved);
  try { lstatSync(at(parent, validName(to))); throw new StagingTopologyError("A staging directory already exists under the published name"); }
  catch (error) { if (errno(error) !== "ENOENT") throw error; }
  renameSync(at(parent, from), at(parent, to));
  verifyEntry(parent, to, moved);
}

/**
 * Remove `parent`'s entry `name` and everything below it. A link or file is
 * unlinked, never followed; a directory is opened without following links,
 * emptied through its own descriptor and removed only while its entry still
 * names that directory. An absent entry is already removed.
 */
export function removeEntry(parent: StagingDirectory, name: string): void {
  const path = at(parent, validName(name));
  let info;
  try { info = lstatSync(path); }
  catch (error) { if (errno(error) === "ENOENT") return; throw error; }
  if (!info.isDirectory()) {
    try { unlinkSync(path); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
    return;
  }
  const dir = openDirectory(path, join(parent.path, name));
  try {
    if (dir.dev !== info.dev || dir.ino !== info.ino) throw new StagingTopologyError("A staging directory changed while it was in use");
    for (const entry of readdirSync(`/proc/self/fd/${dir.fd}`)) removeEntry(dir, entry);
    verifyEntry(parent, name, dir);
    rmdirSync(path);
  } finally { closeSync(dir.fd); }
}

/** Names directly inside an open directory. */
export function listDirectory(dir: StagingDirectory): import("node:fs").Dirent[] {
  return readdirSync(`/proc/self/fd/${dir.fd}`, { withFileTypes: true });
}

/**
 * Remove one staged arrival and its partial, as compensation, reconciliation
 * and inbox cleanup do. `guard` judges each directory by its name relative to
 * the brain before it is removed. A linked staging directory refuses, and a
 * component that changes while it is in use refuses, so the caller keeps its
 * receipt for a later, safe retry; an absent staging directory or arrival is
 * already removed.
 */
export function removeStagedArrival(brainPath: string, stagingId: string, guard?: (path: string) => void): void {
  if (!/^[a-f0-9-]{36}$/.test(stagingId)) throw new Error("Invalid staging id");
  let root: StagingRoot | null | undefined;
  try {
    for (const name of [stagingId, `.${stagingId}.partial`]) {
      guard?.(`${SHARE_STAGING_DIR}/${name}`);
      if (root === undefined) root = openStagingRoot(brainPath, false);
      if (!root) continue;
      root.verify();
      removeEntry(root.dir, name);
    }
  } finally { root?.close(); }
}
