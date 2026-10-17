/** Startup identity guard for the concrete native project/managed settings readers. */
import { nativeWorkerStartupInput, retainWorkerStartupView, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const LIMIT = 4 * 1024 * 1024;
const failed = () => new Error("Native inference settings are unreadable or changed during startup");
async function cleanupOwned(actions: Array<() => unknown>, primary?: unknown): Promise<void> {
  const errors: unknown[] = primary === undefined ? [] : [primary];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Native inference settings cleanup did not complete");
}
function identity(info: BigIntStats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
function input(path: string, expectedRealPath = path): string {
  let info;
  try { info = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw failed(); }
  if (realpathSync(path) !== expectedRealPath) throw failed();
  if (info.isDirectory()) return `directory:${info.dev}:${info.ino}:${info.mode}`;
  if (!info.isFile()) throw failed();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile() || identity(initial) !== identity(info)) throw failed();
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, LIMIT + 1 - bytes), null);
      if (!read) break; bytes += read;
      if (bytes > LIMIT) throw failed(); hash.update(buffer.subarray(0, read));
    }
    if (identity(fstatSync(fd, { bigint: true })) !== identity(initial)) throw failed();
    return `${identity(initial)}:${hash.digest("hex")}`;
  } finally { closeSync(fd); }
}
// Linux inotify is read synchronously at the pre-prompt gate. Event-loop watcher
// callbacks cannot establish that an edit-and-restore was absent before a prompt.
async function loadNativeApi() {
  if (process.platform !== "linux") throw failed();
  try {
    const { dlopen } = await import("bun:ffi");
    return dlopen("libc.so.6", {
  ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
  inotify_init1: { args: ["i32"], returns: "i32" },
  inotify_add_watch: { args: ["i32", "cstring", "u32"], returns: "i32" },
}); } catch { throw failed(); }
}
let nativeApi: ReturnType<typeof loadNativeApi> | undefined;
const MUTATIONS = 0x2 | 0x4 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800;
const LOST = 0x2000 | 0x4000 | 0x8000;
export async function retainNativeRouteInputs(source: string | WorkerStartupView) {
  const pending = nativeApi ??= loadNativeApi();
  let libc: Awaited<typeof pending>;
  try { libc = await pending; }
  catch (error) { if (nativeApi === pending) nativeApi = undefined; throw error; }
  let owner: WorkerStartupView | undefined, rootFd: number | undefined;
  let openedRoot: BigIntStats | undefined;
  const closeRoot = () => {
    if (rootFd === undefined) return;
    try { const current = fstatSync(rootFd, { bigint: true }); if (current.dev === openedRoot?.dev && current.ino === openedRoot.ino) closeSync(rootFd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
    finally { rootFd = undefined; }
  };
  const lexicalRoot = typeof source === "string" ? source : source.root;
  let root = lexicalRoot;
  let nativeIdentity: (() => void) | undefined;
  if (typeof source !== "string") {
    // Only the existing manager-acquired object carries this private attestation.
    // A path or readOnly-looking object cannot grant retained-root authority.
    const native = nativeWorkerStartupInput(source);
    owner = retainWorkerStartupView(source);
    try {
      if (source.root !== native.checkpoint.path || realpathSync(source.root) !== source.root) throw failed();
      rootFd = openSync(source.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = openedRoot = fstatSync(rootFd, { bigint: true });
      const pinned = rootFd;
      nativeIdentity = () => {
        nativeWorkerStartupInput(owner!);
        const current = lstatSync(lexicalRoot, { bigint: true });
        if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino
          || realpathSync(lexicalRoot) !== lexicalRoot || opened.ino !== 256n) throw failed();
        const subvolume = Buffer.alloc(504), filesystem = Buffer.alloc(1024);
        // Linux UAPI, identical to the native manager's fixed inspection reader.
        if (libc.symbols.ioctl(pinned, 0x81f8943c, subvolume) < 0
          || libc.symbols.ioctl(pinned, 0x8400941f, filesystem) < 0
          || subvolume.readBigUInt64LE(0).toString() !== native.checkpoint.rootId
          || subvolume.subarray(296, 312).toString("hex") !== native.checkpoint.uuid
          || subvolume.subarray(312, 328).toString("hex") !== native.checkpoint.sourceUuid
          || subvolume.readBigUInt64LE(344).toString() !== native.checkpoint.transaction
          || !(subvolume.readBigUInt64LE(288) & 1n)
          || filesystem.subarray(16, 32).toString("hex") !== native.checkpoint.fsid.replaceAll("-", "")) throw failed();
      };
      nativeIdentity();
      root = `/proc/self/fd/${rootFd}/.`;
    } catch (error) { await cleanupOwned([closeRoot, () => owner!.cleanup()], error); throw error; }
  }
  const inspect = (path: string) => input(path, rootFd !== undefined && path.startsWith(`/proc/self/fd/${rootFd}/`)
    ? join(lexicalRoot, path.slice(`/proc/self/fd/${rootFd}/`.length)) : path);
  const project = join(root, ".claude", "settings.json"), managed = "/etc/claude-code/managed-settings.json";
  const directory = "/etc/claude-code/managed-settings.d";
  const fd = libc.symbols.inotify_init1(constants.O_NONBLOCK | 0x80000 /* Linux IN_CLOEXEC */);
  if (fd < 0) { await cleanupOwned([closeRoot, () => owner?.cleanup()], failed()); throw failed(); }
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    return closing ??= cleanupOwned([() => closeSync(fd), closeRoot, () => owner?.cleanup()]);
  };
  const watches = new Map<number, ReadonlySet<string> | null>();
  const watch = (path: string, names: readonly string[] | null) => {
    const state = inspect(path);
    if (state === "absent") return;
    if (!state.startsWith("directory:")) throw failed();
    const wd = libc.symbols.inotify_add_watch(fd, Buffer.from(path + "\0"), MUTATIONS | 0x1000000 | 0x2000000);
    if (wd < 0) throw failed();
    const previous = watches.get(wd);
    watches.set(wd, names === null || previous === null ? null : new Set([...(previous ?? []), ...names]));
  };
  const checkEvents = () => {
    const buffer = Buffer.alloc(64 * 1024);
    // A full queue is denied rather than drained indefinitely under a writer.
    for (let batch = 0; batch < 32; batch++) {
      let size: number;
      try { size = readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) { if (["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw failed(); }
      if (size === 0) throw failed();
      for (let offset = 0; offset < size;) {
        if (offset + 16 > size) throw failed();
        const wd = buffer.readInt32LE(offset), mask = buffer.readUInt32LE(offset + 4), length = buffer.readUInt32LE(offset + 12);
        if (offset + 16 + length > size || (mask & LOST) || !watches.has(wd)) throw failed();
        const bytes = buffer.subarray(offset + 16, offset + 16 + length);
        const nul = bytes.indexOf(0), name = bytes.subarray(0, nul < 0 ? bytes.length : nul).toString();
        const names = watches.get(wd);
        if (!name || names === null || names?.has(name)) throw failed();
        offset += 16 + length;
      }
    }
    throw failed();
  };
  const snapshot = () => {
    let children: string[] = [];
    try { children = readdirSync(directory).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failed(); }
    if (children.length > 512) throw failed();
    const paths = [root, dirname(project), project, "/etc", dirname(managed), managed, directory, ...children.map(name => join(directory, name))];
    return JSON.stringify(paths.map(path => [path, inspect(path)]));
  };
  try {
    if (!owner) for (let path = root; dirname(path) !== path; path = dirname(path)) watch(dirname(path), [basename(path)]);
    watch("/", ["etc"]);
    watch(root, [".claude"]);
    watch(dirname(project), ["settings.json"]);
    watch("/etc", ["claude-code"]);
    watch(dirname(managed), ["managed-settings.json", "managed-settings.d"]);
    watch(directory, null);
    const before = snapshot();
    checkEvents();
    return { assertUnchanged() { if (closed) throw failed(); nativeIdentity?.(); checkEvents(); if (snapshot() !== before) throw failed(); checkEvents(); }, close };
  } catch (error) { await cleanupOwned([close], error); throw error; }
}
