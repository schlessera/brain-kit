/** Immutable configuration execution inputs. No git, imports, links followed or shared inodes. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readlinkSync, readSync, rmdirSync, unlinkSync, symlinkSync, writeSync, chmodSync, fchmodSync, ftruncateSync, futimesSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerStateError } from "../../src/server/worker-state-budget.js";
import { FIRST_PARTY_FAILURE_CLASSES } from "../../src/protocol.js";
import { prepareWorkerOutput } from "../../src/server/worker-output.js";

export interface WorkerStartupStorage {
  readonly root: string;
  retain(): void;
  release(): void;
  readonly cleanupPid?: number;
}

export interface WorkerStartupView {
  readonly brain: string;
  readonly root: string;
  readonly storage: WorkerStartupStorage;
  cleanup(): void;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/** Remove only this private copy, even when a worker removed directory access. */
function removePrivateView(owner: string): void {
  // O_PATH obtains an identity without requiring read permission. O_NOFOLLOW
  // and O_DIRECTORY refuse links before chmod touches an opened directory.
  const flags = 0x200000 | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  function empty(fd: number): void {
    chmodSync(`/proc/self/fd/${fd}`, 0o700);
    for (const name of readdirSync(at(fd, "."))) {
      const path = at(fd, name);
      if (lstatSync(path).isDirectory()) {
        const child = openSync(path, flags);
        try { empty(child); } finally { closeSync(child); }
        rmdirSync(path);
      } else unlinkSync(path);
    }
  }
  const fd = openSync(owner, flags);
  try { empty(fd); } finally { closeSync(fd); }
  rmdirSync(owner);
}

/**
 * Copies raw regular-file bytes and link text through anchored descriptors.
 * Never hardlinks: a read-only bind of the live inode is not a snapshot.
 * Special nodes are refused rather than copied into a configuration view.
 * A concurrent change refuses this launch, rather than accepting torn input.
 */
// Literal first-party cleanup only: no imports or code from the brain. The
// pipe closes even after abrupt server exit, releasing private disk copies.
const INPUT_CLEANUP = `import os, stat, sys
sys.stdin.buffer.read()
flags = os.O_PATH | os.O_NOFOLLOW | os.O_DIRECTORY
def empty(fd):
    os.chmod("/proc/self/fd/" + str(fd), 0o700)
    for name in os.listdir("/proc/self/fd/" + str(fd)):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, flags, dir_fd=fd)
            try: empty(child)
            finally: os.close(child)
            os.rmdir(name, dir_fd=fd)
        else: os.unlink(name, dir_fd=fd)
try: fd = os.open(sys.argv[1], flags)
except FileNotFoundError: sys.exit(0)
try: empty(fd)
finally: os.close(fd)
os.rmdir(sys.argv[1])
`;
function createStartupInputStorage(): WorkerStartupStorage {
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 is required for immutable startup input crash cleanup");
  const root = mkdtempSync("/tmp/brain-startup-input-");
  let keeper: ReturnType<typeof Bun.spawn<"pipe", "ignore", "ignore">>;
  try { keeper = Bun.spawn([python, "-I", "-S", "-c", INPUT_CLEANUP, root], { env: {}, stdin: "pipe", stdout: "ignore", stderr: "ignore" }); }
  catch (error) { removePrivateView(root); throw error; }
  let refs = 0, removed = false;
  return { root, cleanupPid: keeper.pid,
    retain() { if (removed) throw new Error("startup input storage is closed"); refs++; },
    release() { if (removed || --refs > 0) return; removed = true;
      try { removePrivateView(root); } finally { keeper.stdin.end(); } },
  };
}

export function createFixtureWorkerStartupView(brain: string, options: { omitGit?: boolean; storage?: WorkerStartupStorage } = {}): WorkerStartupView {
  // /tmp is always masked in every worker; TMPDIR must not put an unmasked
  // alternate copy of the brain (including its secrets) on the host root.
  // Complete immutable inputs retain their existing 4 GiB copy guard; they
  // are not newly staged writes and do not consume the writable allowance.
  const storage = options.storage ?? createStartupInputStorage();
  storage.retain();
  let owner: string;
  try { owner = mkdtempSync(`${storage.root}/startup-`); } catch (error) { storage.release(); throw error; }
  const root = join(owner, "brain");
  let entries = 0;
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  const zeros = Buffer.alloc(buffer.length);
  const stamps: { parts: string[]; info: import("node:fs").Stats }[] = [];
  const same = (a: import("node:fs").Stats, b: import("node:fs").Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function copy(fd: number, destination: string, depth: number, parts: string[] = []): void {
    if (depth > 256) throw new Error("startup view exceeds the directory depth bound");
    const before = fstatSync(fd);
    stamps.push({ parts, info: before });
    mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(at(fd, "."))) {
      // Restricted consumers have no Git configuration or daemon authority.
      if (depth === 0 && options.omitGit && name === ".git") {
        // Keep a mount point for the launcher's empty Git mask, without
        // carrying daemon sockets or configuration into the restricted view.
        if (lstatSync(at(fd, name)).isDirectory()) mkdirSync(join(destination, name));
        else writeFileSync(join(destination, name), "");
        continue;
      }
      if (++entries > 200_000) throw new Error("startup view exceeds 200000 entries");
      const source = at(fd, name);
      const target = join(destination, name);
      const info = lstatSync(source);
      stamps.push({ parts: [...parts, name], info });
      if (info.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target);
        if (!same(info, lstatSync(source))) throw new Error("startup input changed while copying a link");
      } else if (info.isDirectory()) {
        const child = openSync(source, DIRECTORY);
        try {
          if (!same(info, fstatSync(child))) throw new Error("startup directory changed before open");
          copy(child, target, depth + 1, [...parts, name]);
        } finally { closeSync(child); }
      } else if (info.isFile()) {
        const input = openSync(source, FILE);
        let output: number | undefined;
        try {
          const opened = fstatSync(input);
          if (!opened.isFile() || !same(info, opened)) throw new Error("startup file changed before open");
          output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, info.mode & 0o777);
          let position = 0;
          for (;;) {
            const count = readSync(input, buffer);
            if (!count) break;
            bytes += count;
            if (bytes > 4 * 1024 ** 3) throw new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded, "Immutable startup inputs exceed their existing 4 GiB logical copy bound; nothing ran.");
            // Preserve zero extents as holes. A sparse scratch artifact must
            // not allocate its logical size in the bounded private tmpfs.
            if (!buffer.subarray(0, count).equals(zeros.subarray(0, count))) {
              let written = 0;
              while (written < count) written += writeSync(output, buffer, written, count - written, position + written);
            }
            position += count;
          }
          ftruncateSync(output, position);
          if (!same(opened, fstatSync(input))) throw new Error("startup file changed while copying");
          fchmodSync(output, info.mode & 0o777);
          futimesSync(output, info.atime, info.mtime);
        } finally { closeSync(input); if (output !== undefined) closeSync(output); }
      } else {
        throw new Error("startup view contains a socket, FIFO or device");
      }
    }
    if (!same(before, fstatSync(fd))) throw new Error("startup directory membership changed while copying");
    chmodSync(destination, before.mode & 0o777);
    utimesSync(destination, before.atime, before.mtime);
  }
  let fd: number | undefined;
  try {
    fd = openSync(brain, DIRECTORY);
    copy(fd, root, 0);
    // A file copied earlier can change while another file is being read without
    // changing its parent's metadata. Verify every captured identity at commit.
    if (!same(stamps[0]!.info, lstatSync(brain))) throw new Error("startup input changed at the brain root");
    for (const stamp of stamps) {
      if (!stamp.parts.length) {
        if (!same(stamp.info, fstatSync(fd))) throw new Error("startup input changed at the brain root");
        continue;
      }
      let parent = openSync(at(fd, "."), DIRECTORY);
      try {
        for (const part of stamp.parts.slice(0, -1)) {
          const child = openSync(at(parent, part), DIRECTORY); closeSync(parent); parent = child;
        }
        if (!same(stamp.info, lstatSync(at(parent, stamp.parts.at(-1)!)))) throw new Error("startup input changed while copying");
      } finally { closeSync(parent); }
    }
    let removed = false;
    return { brain, root, storage, cleanup() { if (removed) return; removed = true;
      try { removePrivateView(owner); } finally { storage.release(); } } };
  } catch (error) {
    try { removePrivateView(owner); } finally { storage.release(); }
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded, "Immutable startup input storage is full (ENOSPC); nothing ran. This is separate from the staged-write allowance.");
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Explicit test-only byte-copy input; production never reaches this helper. */
export function prepareFixtureWorkerOutput(brain: string, options: Parameters<typeof prepareWorkerOutput>[1] = {}) {
  const view = options.startupView ?? createFixtureWorkerStartupView(brain);
  try {
    const output = prepareWorkerOutput(brain, { ...options, startupView: view });
    return { ...output, cleanup() { try { output.cleanup(); } finally { if (!options.startupView) view.cleanup(); } } };
  } catch (error) { if (!options.startupView) view.cleanup(); throw error; }
}
