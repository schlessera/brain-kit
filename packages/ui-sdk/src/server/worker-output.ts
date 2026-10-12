/** Publication of maintenance results. The worker never receives the live brain as a write mount. */
import { closeSync, constants, fstatSync, fchmodSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync,
  renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { KeyedLock } from "./keyed-lock.js";
import { join, resolve } from "node:path";
import { createWorkerStartupView, type WorkerStartupView } from "./worker-startup-view.js";
import { isEnvName, PROTECTED_TIER_A } from "./protected-paths.js";

/** A named writable work area. Configuration executes at the original brain path, read-only. */
export const WORKER_OUTPUT = "/tmp/brain-maintenance-output";
type Entry = { type: "file" | "directory" | "symlink"; mode: number; members?: string[]; hash?: string; link?: string };
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const equal = (a: Entry | undefined, b: Entry | undefined) => JSON.stringify(a) === JSON.stringify(b);
const equalOutput = (a: Entry | undefined, b: Entry | undefined) => a?.type === "directory" && b?.type === "directory"
  ? equal({ ...a, members: undefined }, { ...b, members: undefined }) : equal(a, b);

function inspect(parent: number, name: string): Entry | undefined {
  const path = at(parent, name);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  const mode = info.mode & 0o777;
  if (info.isSymbolicLink()) return { type: "symlink", mode, link: readlinkSync(path) };
  if (info.isDirectory()) {
    const fd = openSync(path, DIRECTORY);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("maintenance directory changed before open");
      return { type: "directory", mode, members: readdirSync(at(fd, "."), { encoding: "buffer" }).map(name => name.toString("hex")).sort() };
    } finally { closeSync(fd); }
  }
  if (!info.isFile()) throw new Error("maintenance outputs must be regular files, directories or links");
  const fd = openSync(path, FILE);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("maintenance output changed before open");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer); if (!count) break;
      total += count;
      if (total > 4 * 1024 ** 3) throw new Error("maintenance output exceeds 4 GiB");
      hash.update(buffer.subarray(0, count));
    }
    return { type: "file", mode, hash: hash.digest("hex") };
  } finally { closeSync(fd); }
}

function inventory(root: string): Map<string, Entry> {
  const result = new Map<string, Entry>();
  function walk(fd: number, prefix: string, depth: number) {
    if (depth > 256) throw new Error("maintenance output exceeds the directory depth bound");
    for (const name of readdirSync(at(fd, "."))) {
      if (result.size >= 200_000) throw new Error("maintenance output exceeds 200000 entries");
      const rel = prefix ? `${prefix}/${name}` : name;
      const entry = inspect(fd, name)!;
      result.set(rel, entry);
      if (entry.type === "directory") {
        const child = openSync(at(fd, name), DIRECTORY);
        try { walk(child, rel, depth + 1); } finally { closeSync(child); }
      }
    }
  }
  const fd = openSync(root, DIRECTORY);
  try { walk(fd, "", 0); } finally { closeSync(fd); }
  return result;
}

function parent(root: string, rel: string): { fd: number; name: string } {
  const parts = rel.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid maintenance output path");
  let fd = openSync(root, DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openSync(at(fd, part), DIRECTORY); closeSync(fd); fd = next;
    }
    return { fd, name: parts.at(-1)! };
  } catch (error) { closeSync(fd); throw error; }
}

function current(root: string, rel: string): Entry | undefined {
  let handle: ReturnType<typeof parent>;
  try { handle = parent(root, rel); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return inspect(handle.fd, handle.name); } finally { closeSync(handle.fd); }
}

/** Shared snapshots stay private, including the writable output workspace. */
export function prepareWorkerOutput(brain: string, options: { startupView?: WorkerStartupView; areas?: readonly string[] } = {}) {
  const view = options.startupView ?? createWorkerStartupView(brain);
  let output: WorkerStartupView;
  try { output = createWorkerStartupView(view.root, { storage: view.storage }); } catch (error) { if (!options.startupView) view.cleanup(); throw error; }
  let before: Map<string, Entry>;
  try { before = inventory(view.root); }
  catch (error) { try { output.cleanup(); } finally { if (!options.startupView) view.cleanup(); } throw error; }
  const publication = {
    view, output: { source: output.root, target: WORKER_OUTPUT },
    cleanup() { try { output.cleanup(); } finally { if (!options.startupView) view.cleanup(); } },
    /**
     * All paths and bases are validated before publication. No link supplied
     * by a worker can redirect a host open, and no worker output writes policy.
     * Call under the server's writer/keyed locks, after the whole worker exits.
     */
    publish() {
      const after = inventory(output.root);
      // Mount points for absent read-only Git inputs are namespace plumbing,
      // not new repository outputs. Nonempty/modified entries are still checked.
      for (const rel of [".git/hooks", ".git/info", ".git/modules"]) {
        if (!before.has(rel) && after.get(rel)?.type === "directory" && ![...after.keys()].some(path => path.startsWith(`${rel}/`))) after.delete(rel);
      }
      const selected = (rel: string) => !options.areas || options.areas.some(area => rel === area || rel.startsWith(`${area}/`));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(rel => selected(rel) && !equalOutput(before.get(rel), after.get(rel)));
      for (const rel of changed) {
        const previous = before.get(rel);
        const next = after.get(rel);
        // Refuse an incompatible replacement before any child is deleted.
        if (previous && next && (previous.type === "directory") !== (next.type === "directory")) {
          throw new Error(`maintenance cannot replace a directory with a non-directory or vice versa: ${rel}`);
        }
        if (isEnvName(rel.split("/")[0]!) || PROTECTED_TIER_A.some(path => rel === path || rel.startsWith(`${path}/`))) {
          throw new Error(`maintenance output cannot change protected input ${rel}`);
        }
        const entry = after.get(rel);
        if (entry?.type === "symlink") {
          const target = resolve(brain, join(rel, ".."), entry.link!);
          if ((target !== brain && !target.startsWith(`${brain}/`)) || rel.startsWith(".git/")
            || PROTECTED_TIER_A.some(path => path.startsWith(`${rel}/`))) throw new Error(`maintenance output has an escaping link: ${rel}`);
        }
        const authoritative = current(brain, rel);
        const matches = before.get(rel)?.type === "directory" && !after.has(rel)
          ? equal(before.get(rel), authoritative) : equalOutput(before.get(rel), authoritative);
        if (!matches) throw new Error(`stale maintenance output: ${rel}`);
      }
      // Delete leaves first, then create directories before their children.
      const deleted = changed.filter(rel => !after.has(rel)).sort((a, b) => b.split("/").length - a.split("/").length);
      for (const rel of deleted) {
        const handle = parent(brain, rel);
        try {
          if (!equalOutput(before.get(rel), inspect(handle.fd, handle.name))) throw new Error(`stale maintenance output: ${rel}`);
          if (before.get(rel)!.type === "directory") rmdirSync(at(handle.fd, handle.name));
          else unlinkSync(at(handle.fd, handle.name));
        } finally { closeSync(handle.fd); }
      }
      const directoryModes: { fd: number; mode: number; temporaryMode: number; rel: string; parent: number; name: string; path: string; parentPath: string }[] = [];
      let publicationError: unknown;
      try {
        for (const rel of changed.filter(rel => after.has(rel)).sort((a, b) => a.split("/").length - b.split("/").length)) {
          const entry = after.get(rel)!;
          const handle = parent(brain, rel);
          try {
            if (!equalOutput(before.get(rel), inspect(handle.fd, handle.name))) throw new Error(`stale maintenance output: ${rel}`);
            const destination = at(handle.fd, handle.name);
            if (entry.type === "directory") {
              if (!before.has(rel)) mkdirSync(destination, { mode: entry.mode | 0o700 });
              else if (before.get(rel)!.type !== "directory") throw new Error("maintenance cannot replace a non-directory with a directory");
              const directory = openSync(destination, DIRECTORY);
              // Children must be installed before a final read-only directory
              // mode. Retain the exact opened directory for final chmod.
              try {
                const temporaryMode = entry.mode | 0o700;
                fchmodSync(directory, temporaryMode);
                const parentFd = openSync(at(handle.fd, "."), DIRECTORY);
                try {
                  directoryModes.push({ fd: directory, mode: entry.mode, temporaryMode, rel, parent: parentFd, name: handle.name,
                    path: readlinkSync(`/proc/self/fd/${directory}`), parentPath: readlinkSync(`/proc/self/fd/${parentFd}`) });
                } catch (error) { closeSync(parentFd); throw error; }
              }
              catch (error) { closeSync(directory); throw error; }
              continue;
            }
            if (before.get(rel)?.type === "directory") throw new Error("maintenance cannot replace a directory with a non-directory");
            const temporary = at(handle.fd, `.maintenance-${randomUUID()}`);
            try {
              if (entry.type === "symlink") symlinkSync(entry.link!, temporary);
              else {
                const source = parent(output.root, rel);
                let input: number | undefined; let target: number | undefined;
                try {
                  input = openSync(at(source.fd, source.name), FILE);
                  if (!fstatSync(input).isFile()) throw new Error("not a regular maintenance output");
                  target = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, entry.mode);
                  const buffer = Buffer.alloc(64 * 1024);
                  for (;;) {
                    const count = readSync(input, buffer); if (!count) break;
                    let written = 0;
                    while (written < count) written += writeSync(target, buffer, written, count - written);
                  }
                  fchmodSync(target, entry.mode);
                } finally { closeSync(source.fd); if (input !== undefined) closeSync(input); if (target !== undefined) closeSync(target); }
              }
              // Copying can be slow while governed peers are running. The base
              // check belongs after that copy, immediately before publication.
              if (!equalOutput(before.get(rel), inspect(handle.fd, handle.name))) throw new Error(`stale maintenance output: ${rel}`);
              if (before.has(rel)) renameSync(temporary, destination);
              else {
                // link(2) installs a new file/link atomically without replacing
                // an authoritative name created after the final check.
                try { linkSync(temporary, destination); }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`stale maintenance output: ${rel}`);
                  throw error;
                }
              }
            } finally { rmSync(temporary, { force: true }); }
          } finally { closeSync(handle.fd); }
        }
      } catch (error) { publicationError = error; }
      // Deepest directories first; permissions on a parent cannot prevent
      // finalizing a child through its already-held descriptor.
      for (const directory of directoryModes.reverse()) {
        try {
          const held = fstatSync(directory.fd);
          // Keep the original parent handle. A peer may remove search access
          // from an ancestor; reopening the path would prevent child cleanup.
          let visible;
          try { visible = lstatSync(at(directory.parent, directory.name), { throwIfNoEntry: false }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
            // /proc reports the held inode's current kernel dentry path without
            // searching inaccessible ancestors. Moves/unlinks of either held
            // directory change these paths. The worker cannot mount over host
            // dentries from its separate mount namespace.
            if (readlinkSync(`/proc/self/fd/${directory.fd}`) !== directory.path
              || readlinkSync(`/proc/self/fd/${directory.parent}`) !== directory.parentPath) throw error;
            visible = held;
          }
          if (!visible?.isDirectory() || visible.dev !== held.dev || visible.ino !== held.ino
            || (held.mode & 0o777) !== directory.temporaryMode) throw new Error(`stale maintenance output: ${directory.rel}`);
          fchmodSync(directory.fd, directory.mode);
        } catch (error) { publicationError ??= error; }
        finally {
          try { closeSync(directory.fd); } catch (error) { publicationError ??= error; }
          try { closeSync(directory.parent); } catch (error) { publicationError ??= error; }
        }
      }
      if (publicationError) throw publicationError;
    },
  };
  return { ...publication,
    async publishLocked(lock: KeyedLock) {
      const after = inventory(output.root);
      const selected = (rel: string) => !options.areas || options.areas.some(area => rel === area || rel.startsWith(`${area}/`));
      const paths = [...new Set([...before.keys(), ...after.keys()])]
        .filter(rel => selected(rel) && !equalOutput(before.get(rel), after.get(rel))).sort();
      const releases: (() => void)[] = [];
      try {
        // Match the server keys used by native writes in both adapters. Order
        // multiple keys consistently and retain them through the final commit.
        for (const rel of paths) releases.push(await lock.acquire(`path:${join(brain, rel)}`));
        publication.publish();
      } finally { for (const release of releases.reverse()) release(); }
    },
  };
}
