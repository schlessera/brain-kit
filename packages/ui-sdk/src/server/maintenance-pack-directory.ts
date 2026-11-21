/** Linux directory publication: a pack family becomes visible in one rename. */
import { createRequire } from "node:module";
import { closeSync, constants, copyFileSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync } from "node:fs";
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
let exchange: ((from: number, name: string, to: number, target: string, flags: number) => void) | undefined;
/** Lazy FFI keeps Node imports usable; qualified publication runs on Linux/Bun. */
export function renamePackDirectory(from: number, name: string, to: number, target: string, exists: boolean): void {
  if (!exchange) {
    const { dlopen, read } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
    const api = dlopen("libc.so.6", {
      renameat2: { args: ["i32", "cstring", "i32", "cstring", "u32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });
    exchange = (source, sourceName, destination, destinationName, flags) => {
      if (api.symbols.renameat2(source, Buffer.from(sourceName + "\0"), destination, Buffer.from(destinationName + "\0"), flags) !== 0)
        throw Object.assign(Error("Atomic Git pack directory publication refused"), { errno: read.i32(api.symbols.__errno_location()!, 0) });
    };
  }
  exchange(from, name, to, target, exists ? 2 : 1); // RENAME_EXCHANGE / RENAME_NOREPLACE
}
/** Clone immutable existing files; never follow a repository-provided link. */
export function clonePackDirectory(source: number, target: number, depth = 0): void {
  if (depth > 8) throw Error("Git pack directory depth exceeds bound");
  for (const entry of readdirSync(at(source, "."), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      mkdirSync(at(target, entry.name), { mode: 0o700 });
      const input = openSync(at(source, entry.name), DIRECTORY), output = openSync(at(target, entry.name), DIRECTORY);
      try { clonePackDirectory(input, output, depth + 1);fchmodSync(output,fstatSync(input).mode & 0o7777);fsyncSync(output); } finally { closeSync(input); closeSync(output); }
    } else {
      const input = openSync(at(source, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(input).isFile()) throw Error("Git pack member is not a regular file");
        // Qualification requires Btrfs. Refuse a failed reflink rather than
        // silently duplicating an unbounded existing pack on the live store.
        copyFileSync(`/proc/self/fd/${input}`, at(target, entry.name), constants.COPYFILE_FICLONE_FORCE);
        const output = openSync(at(target, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(output); } finally { closeSync(output); }
      } finally { closeSync(input); }
    }
  }
  fsyncSync(target);
}
/** Recover only this publisher's private, same-owner transaction directories. */
export function recoverPackDirectories(objects: number): void {
  // A killed publisher may have exchanged names before its directory barrier.
  fsyncSync(objects);
  for (const entry of readdirSync(at(objects, "."), { withFileTypes: true })) {
    if (!/^\.brain-maintenance-[a-f0-9-]{36}$/.test(entry.name) || !entry.isDirectory()) continue;
    const directory = openSync(at(objects, entry.name), DIRECTORY);
    try {
      const info = fstatSync(directory);
      if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw Error("Foreign Git publication transaction");
      rmSync(at(directory, "pack"), { recursive: true, force: true });
      rmSync(at(directory, "files"), { recursive: true, force: true });
      // rmdir refuses unexpected members rather than deleting unknown data.
    } finally { closeSync(directory); }
    rmdirSync(at(objects, entry.name));fsyncSync(objects);
  }
}
