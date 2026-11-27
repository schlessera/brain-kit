/**
 * Copy-staged worker output, kept for tests only (#4685, #4707).
 *
 * Production publishes a worker's writable areas through native output
 * (`prepareNativeWorkerOutput`, `packages/ui-sdk/src/server/worker-native-output.ts`);
 * the full-copy startup view this protocol was built for is gone
 * (`docs/decisions/native-brain-storage.md`), so no host can run it. Tests
 * that are not about storage still use it as a cheap explicit fixture beside
 * `worker-startup-view-fixture.ts`. It is test code: it is not kept in step
 * with the native implementation. The launcher-private helpers it needs are
 * copied here, so `src` exports nothing for its benefit.
 */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { closeSync, constants, fstatSync, fchmodSync, lstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  renameSync, rmSync, rmdirSync, statfsSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { KeyedLock } from "../../src/server/keyed-lock.js";
import { createWorkerStartupView, isNativeWorkerStartupRoot, type WorkerStartupView } from "../../src/server/worker-startup-view.js";
import { WorkerHostError } from "../../src/server/worker-launcher.js";
import { isEnvName, PROTECTED_TIER_A } from "../../src/server/protected-paths.js";
import { ProtectedMaintenanceOutputError } from "../../src/server/protected-output-error.js";
import { at, DIRECTORY, noFollowParent } from "../../src/server/no-follow-walk.js";
import { parseProcStat, procChildren, readProcStat } from "../../src/server/proc-identity.js";
import { createWorkerPipes } from "../../src/server/worker-pipes.js";
import { hostOutputStagingLimits, type WorkerStateLimits, validWorkerStateBytes } from "../../src/server/worker-state-limits.js";
import { processStateLedger } from "../../src/server/worker-state-budget.js";

/** The only lower path copy-staging accepts: a startup view from `worker-startup-view-fixture.ts`. */
const FIXTURE_LOWER_ROOT = /^\/tmp\/brain-startup-input-[A-Za-z0-9]+\/startup-[A-Za-z0-9]+\/brain$/;
const TMPFS_MAGIC = 0x01021994;
const STATE_SETUP_MS = 5_000;

/** Whether a process has exited: gone, or a zombie its parent has not reaped yet. */
function exited(pid: number): boolean {
  try { const stat = readProcStat(pid); return stat === undefined || stat.state === "Z"; }
  catch { return true; }
}

/**
 * The sandbox's first process: the only child bubblewrap forks. Read from
 * the kernel's own record of bubblewrap's children, so nothing inside the
 * sandbox can name it.
 */
export function sandboxPid(bwrap: number, deadline: number): number {
  for (;;) {
    const children = procChildren(bwrap);
    if (children.length === 1) return children[0]!.pid;
    if (children.length > 1) throw new WorkerHostError("bubblewrap started more than one sandbox process");
    if (exited(bwrap)) throw new WorkerHostError("bubblewrap exited before it started its sandbox");
    if (Date.now() > deadline) throw new WorkerHostError("bubblewrap did not start its sandbox in time");
    Bun.sleepSync(1);
  }
}

/**
 * Opens the staging helper's private tmpfs from outside, through its
 * sandbox's root: a mount of its own of exactly the allowance, holding only
 * the overlay's directories once the lower path is mounted.
 */
function openPrivateStaging(bwrap: number, pid: number, bytes: number, deadline: number, mount: string, stagingDirectories: boolean): number {
  const path = `/proc/${pid}/root${mount}`;
  let last = "it never appeared";
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const root = `/proc/self/fd/${fd}`;
      const fs = statfsSync(root);
      if (fs.type === TMPFS_MAGIC && fs.blocks * fs.bsize === bytes && fstatSync(fd).dev !== statSync(`${root}/..`).dev
        && (stagingDirectories ? readdirSync(root).every(name => ["upper", "work", "merged"].includes(name)) : readdirSync(root).length === 0)) return fd;
      last = "it was not yet the private tmpfs";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
        if (fd !== undefined) closeSync(fd);
        throw new WorkerHostError("the server cannot reach its worker's private runtime state through /proc (is bubblewrap installed setuid, or /proc mounted with hidepid?)");
      }
      last = (error as Error).message;
    }
    if (fd !== undefined) closeSync(fd);
    if (exited(pid) || exited(bwrap)) throw new WorkerHostError(`bubblewrap exited before it mounted the worker's private runtime-state tmpfs (${last})`);
    if (Date.now() > deadline) throw new WorkerHostError(`the worker's private runtime-state tmpfs was not mounted in time (${last})`);
    Bun.sleepSync(1);
  }
}

/**
 * A server-owned, kernel-bounded tmpfs, held by a trusted mount helper
 * until publication finishes. No host directory backs the stored bytes.
 * Only writable upper-layer bytes occupy this allowance. Immutable startup
 * inputs live separately and cannot be modified through this merged view.
 */
export function createOutputStagingStorage(limits: WorkerStateLimits = hostOutputStagingLimits(), lowerRoot?: string) {
  const reservation = processStateLedger().reserve(undefined, undefined, limits);
  let mount: string;
  try { mount = mkdtempSync("/tmp/brain-output-staging-"); } catch (error) { reservation.release(); throw error; }
  let fd: number | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let pipes: ReturnType<typeof createWorkerPipes> | undefined;
  try {
    validWorkerStateBytes(limits.allowanceBytes, "output staging allowance");
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new WorkerHostError("bubblewrap is missing");
    if (lowerRoot && !isNativeWorkerStartupRoot(lowerRoot) && !FIXTURE_LOWER_ROOT.test(lowerRoot)) {
      throw new WorkerHostError("output staging requires a server-owned immutable lower path");
    }
    if (lowerRoot && /[,:\\]/.test(lowerRoot)) throw new WorkerHostError("native output staging requires a managed store path without colon, comma or backslash mount-option delimiters");
    if (lowerRoot && isNativeWorkerStartupRoot(lowerRoot)) throw new WorkerHostError("native output staging requires asynchronously prepared trusted OverlayFS through the configured native manager; userxattr fallback is unavailable");
    const mountProgram = lowerRoot ? Bun.which("mount") : undefined;
    if (lowerRoot && !mountProgram) throw new WorkerHostError("util-linux mount is required for bounded copy-on-write output staging");
    pipes = createWorkerPipes();
    // This helper executes only the literal shell below, never repository
    // inputs. Preserve source mount writability so the final worker can
    // rebind an explicitly allowed maintenance span sink. The final worker
    // applies its own read-only root and complete boundary before agent code.
    const setupScript = '"$4" -i -n -t tmpfs -o "size=$3,mode=700" tmpfs "$2" && mkdir "$2/upper" "$2/work" "$2/merged" && "$4" -i -n -t overlay overlay -o "lowerdir=$1,upperdir=$2/upper,workdir=$2/work,userxattr" "$2/merged" || exit 126; printf "ready\\n"; IFS= read -r go; exit 0';
    const unshare = lowerRoot ? Bun.which("unshare") : undefined;
    if (lowerRoot && !unshare) throw new WorkerHostError("util-linux unshare is required for bounded copy-on-write output staging");
    const keeperCommand = lowerRoot
      ? [unshare!, "--user", "--map-root-user", "--mount", "--net", "--ipc", "--uts", "--fork", "--kill-child=SIGKILL",
        "/bin/sh", "-c", setupScript, "brain-output-keeper", lowerRoot, mount, String(limits.allowanceBytes), mountProgram!]
      : [bwrap, "--unshare-user", "--unshare-net", "--unshare-ipc", "--unshare-uts",
        "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--bind", "/", "/", "--proc", "/proc",
        ...["null", "zero", "full", "random", "urandom", "tty"].flatMap(name => ["--dev-bind", `/dev/${name}`, `/dev/${name}`]),
        "--size", String(limits.allowanceBytes), "--tmpfs", mount,
        "--clearenv", "--", "/bin/sh", "-c", 'printf "ready\\n"; IFS= read -r go; exit 0'];
    child = Bun.spawn(keeperCommand, { env: {}, stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    pipes.closeChild();
    const deadline = Date.now() + STATE_SETUP_MS;
    fd = openPrivateStaging(child.pid, sandboxPid(child.pid, deadline), limits.allowanceBytes, deadline, mount, Boolean(lowerRoot));
    const namespacePid = sandboxPid(child.pid, deadline);
    // Older bubblewrap switches user namespaces after mounting. Wait for
    // the trusted shell itself before asking nsenter to join the finished pair.
    const ready = openSync(`/proc/self/fd/${pipes.parent[1]}`, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      let received = "";
      const buffer = Buffer.alloc(16);
      while (received !== "ready\n") {
        try { received += buffer.subarray(0, readSync(ready, buffer)).toString(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; }
        if (received === "ready\n") break;
        if (exited(child.pid) || Date.now() > deadline) throw new WorkerHostError("output-staging helper did not become ready");
        Bun.sleepSync(1);
      }
    } finally { closeSync(ready); }
    const owned = fd;
    let refs = 0, closed = false;
    // Only the server reads this descriptor alias. Worker mount sources are
    // resolved inside the keeper namespace, then masked by their own /tmp.
    const root = `/proc/${process.pid}/fd/${owned}`;
    void child.exited.finally(() => pipes!.cleanup());
    const namespaceStart = parseProcStat(readFileSync(`/proc/${namespacePid}/stat`, "utf8")).start;
    return { root, mount, namespacePid, namespaceStart, allowanceBytes: reservation.outputStagingBytes,
      retain() { if (closed) throw new Error("output staging is closed"); refs++; },
      release() { if (closed || --refs > 0) return; closed = true; child!.kill("SIGKILL"); closeSync(owned); rmSync(mount, { recursive: true, force: true }); reservation.release(); },
    };
  } catch (error) {
    child?.kill("SIGKILL");
    if (fd !== undefined) closeSync(fd);
    const detail = pipes ? launchDiagnostics(pipes.parent[2]) : "";
    pipes?.cleanup(); rmSync(mount, { recursive: true, force: true }); reservation.release();
    if (detail) throw new WorkerHostError(detail);
    throw error;
  }
}

/** What bubblewrap wrote to the worker's stderr so far, read without waiting. */
function launchDiagnostics(stderr: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/self/fd/${stderr}`, constants.O_RDONLY | constants.O_NONBLOCK);
    const chunk = Buffer.alloc(4096);
    return chunk.subarray(0, readSync(fd, chunk)).toString("utf8").trim().slice(0, 400);
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A named writable work area. Configuration executes at the original brain path, read-only. */
export const WORKER_OUTPUT = "/tmp/brain-maintenance-output";
type Entry = { type: "file" | "directory" | "symlink"; mode: number; members?: string[]; hash?: string; link?: string };
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
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

const parent = (root: string, rel: string) => noFollowParent(root, rel, "invalid maintenance output path");

/** One output file's bytes, opened without following links; null when absent or not a regular file. */
function readOutputFile(root: string, rel: string, bound: number): Uint8Array | null {
  let handle: ReturnType<typeof parent>;
  try { handle = parent(root, rel); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
  try {
    let fd: number;
    try { fd = openSync(at(handle.fd, handle.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) return null;
      if (info.size > bound) throw new Error(`Refused output ${rel} exceeds ${bound} bytes`);
      const bytes = Buffer.alloc(info.size);
      let read = 0;
      while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, null); if (!n) break; read += n; }
      return bytes.subarray(0, read);
    } finally { closeSync(fd); }
  } finally { closeSync(handle.fd); }
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
  try {
    const storage = createOutputStagingStorage(undefined, view.root);
    storage.retain();
    output = { brain: view.brain, root: `${storage.root}/merged`, storage, cleanup() { storage.release(); } };
  } catch (error) { if (!options.startupView) view.cleanup(); throw error; }
  let before: Map<string, Entry>;
  try { before = inventory(view.root); }
  catch (error) { try { output.cleanup(); } finally { if (!options.startupView) view.cleanup(); } throw error; }
  let discardGit = false;
  const publication = {
    discardGit() { discardGit = true; },
    view, output: { source: output.root, target: WORKER_OUTPUT, storage: output.storage as ReturnType<typeof createOutputStagingStorage> },
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
        if (!before.has(rel) && after.get(rel)?.type === "directory" && ![...after.keys()].some(path => isWithin(rel, path, { includeRoot: false }))) after.delete(rel);
      }
      const selected = (rel: string) => !(discardGit && isWithin(".git", rel)) && (!options.areas || options.areas.some(area => isWithin(area, rel)));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(rel => selected(rel) && !equalOutput(before.get(rel), after.get(rel)));
      // Every refused tier A change, named before anything is written (#4256).
      const refused = changed.filter(rel => isEnvName(rel.split("/")[0]!) || PROTECTED_TIER_A.some(path => isWithin(path, rel)));
      if (refused.length) throw new ProtectedMaintenanceOutputError(refused, async (rel, bound) => readOutputFile(output.root, rel, bound));
      for (const rel of changed) {
        const previous = before.get(rel);
        const next = after.get(rel);
        // Refuse an incompatible replacement before any child is deleted.
        if (previous && next && (previous.type === "directory") !== (next.type === "directory")) {
          throw new Error(`maintenance cannot replace a directory with a non-directory or vice versa: ${rel}`);
        }
        if (isEnvName(rel.split("/")[0]!) || PROTECTED_TIER_A.some(path => isWithin(path, rel))) {
          throw new Error(`maintenance output cannot change protected input ${rel}`);
        }
        const entry = after.get(rel);
        if (entry?.type === "symlink") {
          const target = resolve(brain, join(rel, ".."), entry.link!);
          if (!isWithin(brain, target) || rel.startsWith(".git/")
            || PROTECTED_TIER_A.some(path => isWithin(rel, path, { includeRoot: false }))) throw new Error(`maintenance output has an escaping link: ${rel}`);
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
      const selected = (rel: string) => !(discardGit && isWithin(".git", rel)) && (!options.areas || options.areas.some(area => isWithin(area, rel)));
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
