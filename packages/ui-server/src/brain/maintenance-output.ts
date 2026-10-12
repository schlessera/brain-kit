/** Publication of maintenance results. The worker never receives the live brain as a write mount. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync,
  renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createWorkerStartupView, isEnvName, PROTECTED_TIER_A, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";

/** A named writable work area. Configuration executes at the original brain path, read-only. */
export const MAINTENANCE_OUTPUT = "/tmp/brain-maintenance-output";
type Entry = { type: "file" | "directory" | "symlink"; mode: number; hash?: string; link?: string };
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const equal = (a: Entry | undefined, b: Entry | undefined) => JSON.stringify(a) === JSON.stringify(b);

function inspect(parent: number, name: string): Entry | undefined {
  const path = at(parent, name);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  const mode = info.mode & 0o777;
  if (info.isSymbolicLink()) return { type: "symlink", mode, link: readlinkSync(path) };
  if (info.isDirectory()) return { type: "directory", mode };
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
export function prepareMaintenanceOutput(brain: string) {
  const view = createWorkerStartupView(brain);
  let output: WorkerStartupView;
  try { output = createWorkerStartupView(view.root); } catch (error) { view.cleanup(); throw error; }
  const before = inventory(view.root);
  return {
    view, output: { source: output.root, target: MAINTENANCE_OUTPUT },
    cleanup() { output.cleanup(); view.cleanup(); },
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
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(rel => !equal(before.get(rel), after.get(rel)));
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
        if (!equal(before.get(rel), current(brain, rel))) throw new Error(`stale maintenance output: ${rel}`);
      }
      // Delete leaves first, then create directories before their children.
      const deleted = changed.filter(rel => !after.has(rel)).sort((a, b) => b.split("/").length - a.split("/").length);
      for (const rel of deleted) {
        const handle = parent(brain, rel);
        try {
          if (!equal(before.get(rel), inspect(handle.fd, handle.name))) throw new Error(`stale maintenance output: ${rel}`);
          if (before.get(rel)!.type === "directory") rmdirSync(at(handle.fd, handle.name));
          else unlinkSync(at(handle.fd, handle.name));
        } finally { closeSync(handle.fd); }
      }
      for (const rel of changed.filter(rel => after.has(rel)).sort((a, b) => a.split("/").length - b.split("/").length)) {
        const entry = after.get(rel)!;
        const handle = parent(brain, rel);
        try {
          if (!equal(before.get(rel), inspect(handle.fd, handle.name))) throw new Error(`stale maintenance output: ${rel}`);
          const destination = at(handle.fd, handle.name);
          if (entry.type === "directory") {
            if (!before.has(rel)) mkdirSync(destination, { mode: entry.mode });
            else if (before.get(rel)!.type !== "directory") throw new Error("maintenance cannot replace a non-directory with a directory");
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
              } finally { closeSync(source.fd); if (input !== undefined) closeSync(input); if (target !== undefined) closeSync(target); }
            }
            renameSync(temporary, destination);
          } finally { rmSync(temporary, { force: true }); }
        } finally { closeSync(handle.fd); }
      }
    },
  };
}
