/** Immutable configuration execution inputs. No git, imports, links followed or shared inodes. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readlinkSync, readSync, rmSync, symlinkSync, writeSync, chmodSync, fchmodSync, futimesSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkerStartupView {
  readonly brain: string;
  readonly root: string;
  cleanup(): void;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/**
 * Copies raw regular-file bytes and link text through anchored descriptors.
 * Never hardlinks: a read-only bind of the live inode is not a snapshot.
 * Special nodes are refused rather than copied into a configuration view.
 * A concurrent change refuses this launch, rather than accepting torn input.
 */
export function createWorkerStartupView(brain: string, options: { omitGit?: boolean } = {}): WorkerStartupView {
  // /tmp is always masked in every worker; TMPDIR must not put an unmasked
  // alternate copy of the brain (including its secrets) on the host root.
  const owner = mkdtempSync("/tmp/brain-startup-view-");
  const root = join(owner, "brain");
  let entries = 0;
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  const same = (a: import("node:fs").Stats, b: import("node:fs").Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function copy(fd: number, destination: string, depth: number): void {
    if (depth > 256) throw new Error("startup view exceeds the directory depth bound");
    const before = fstatSync(fd);
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
      if (info.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target);
        if (!same(info, lstatSync(source))) throw new Error("startup input changed while copying a link");
      } else if (info.isDirectory()) {
        const child = openSync(source, DIRECTORY);
        try {
          if (!same(info, fstatSync(child))) throw new Error("startup directory changed before open");
          copy(child, target, depth + 1);
        } finally { closeSync(child); }
      } else if (info.isFile()) {
        const input = openSync(source, FILE);
        let output: number | undefined;
        try {
          const opened = fstatSync(input);
          if (!opened.isFile() || !same(info, opened)) throw new Error("startup file changed before open");
          output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, info.mode & 0o777);
          for (;;) {
            const count = readSync(input, buffer);
            if (!count) break;
            bytes += count;
            if (bytes > 4 * 1024 ** 3) throw new Error("startup view exceeds 4 GiB");
            let written = 0;
            while (written < count) written += writeSync(output, buffer, written, count - written);
          }
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
    return { brain, root, cleanup: () => rmSync(owner, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(owner, { recursive: true, force: true });
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
