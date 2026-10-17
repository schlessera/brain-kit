/** Descriptor-anchored reads for the fixed CI build operation; Linux only. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, readlinkSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const version = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const object = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}`;
const LIMIT = 512 * 1024 * 1024;
/** Keep every ancestor descriptor until the final post-read binding check. */
function anchored<T>(path: string, action: (parent: number, name: string) => T): T {
  if (process.platform !== "linux") throw new Error("Unsupported fixed build file platform");
  const parts = resolve(path).split("/").filter(Boolean), name = parts.pop() ?? ".";
  const fds: number[] = [], links: { parent: number; name: string; fd: number; stat: BigIntStats }[] = [];
  try {
    let parent = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); fds.push(parent);
    for (const part of parts) {
      const fd = openSync(at(parent, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fds.push(fd); const stat = fstatSync(fd, { bigint: true });
      if (object(lstatSync(at(parent, part), { bigint: true })) !== object(stat)) throw new Error("Build ancestor changed");
      links.push({ parent, name: part, fd, stat }); parent = fd;
    }
    const result = action(parent, name);
    for (const link of links) if (object(fstatSync(link.fd, { bigint: true })) !== object(link.stat) || object(lstatSync(at(link.parent, link.name), { bigint: true })) !== object(link.stat)) throw new Error("Build ancestor changed");
    return result;
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
export function buildStat(path: string): BigIntStats { return anchored(path, (parent, name) => lstatSync(at(parent, name), { bigint: true })); }
export function buildRead(path: string, expected?: BigIntStats, limit = LIMIT): { bytes: Buffer; stat: BigIntStats } {
  return anchored(path, (parent, name) => {
    const before = lstatSync(at(parent, name), { bigint: true });
    if (!before.isFile() || (expected && version(before) !== version(expected)) || before.size > BigInt(limit)) throw new Error("Unsupported or changed build file");
    const fd = openSync(at(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || version(opened) !== version(before)) throw new Error("Build file changed before capture");
      const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
      while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) throw new Error("Build file shortened"); offset += n; }
      if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || version(fstatSync(fd, { bigint: true })) !== version(opened) || version(lstatSync(at(parent, name), { bigint: true })) !== version(opened)) throw new Error("Build file changed during capture");
      return { bytes, stat: opened };
    } finally { closeSync(fd); }
  });
}
export function buildNames(path: string, expected?: BigIntStats): string[] {
  return anchored(path, (parent, name) => {
    const before = lstatSync(at(parent, name), { bigint: true });
    if (!before.isDirectory() || (expected && version(before) !== version(expected))) throw new Error("Build directory changed");
    const fd = openSync(at(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (version(fstatSync(fd, { bigint: true })) !== version(before)) throw new Error("Build directory changed");
      const names = readdirSync(`/proc/self/fd/${fd}`).sort();
      if (version(fstatSync(fd, { bigint: true })) !== version(before) || version(lstatSync(at(parent, name), { bigint: true })) !== version(before)) throw new Error("Build directory changed");
      return names;
    } finally { closeSync(fd); }
  });
}
export function buildLink(path: string, expected: BigIntStats): string {
  return anchored(path, (parent, name) => {
    if (!expected.isSymbolicLink() || version(lstatSync(at(parent, name), { bigint: true })) !== version(expected)) throw new Error("Build link changed");
    const target = readlinkSync(at(parent, name));
    if (version(lstatSync(at(parent, name), { bigint: true })) !== version(expected)) throw new Error("Build link changed");
    return target;
  });
}

/** The fixed image bootstrap creates these inside its fresh operation tmpfs. */
export function checkBuildPrivateDirectory(path: string): void {
  const stat = buildStat(path);
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || stat.gid !== BigInt(process.getgid!()) || (stat.mode & 0o7777n) !== 0o700n) throw new Error("Invalid private build directory");
}
