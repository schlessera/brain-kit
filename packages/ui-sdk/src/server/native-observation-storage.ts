/** Host-owned integrity metadata. Never included in a worker transcript or brain index. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { NativeFileVersion } from "./native-file-versions.js";

/**
 * Every operation here waits on the file system through `node:fs/promises`,
 * so a loaded host's fsync never blocks the hosted server's event loop (#2416).
 */
export interface NativeObservationStorage { directory: string; brainPath: string; sessionId: string }
interface RecordData { incomplete: boolean; observed: Array<[string, NativeFileVersion]> }
const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function directory(path: string, brain: string): Promise<void> {
  if (path === brain || path.startsWith(brain + "/")) throw new Error("Native observations must be outside the brain.");
  try {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error("Native observation storage is redirected.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await directory(dirname(path), brain);
    // A concurrent save may create it first; it is then validated as an existing one.
    try { await mkdir(path, { mode: 0o700 }); }
    catch (created) {
      if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created;
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error("Native observation storage is redirected.");
    }
    await syncDirectory(dirname(path));
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function location(storage: NativeObservationStorage): Promise<{ path: string; identity: string }> {
  const brain = await realpath(storage.brainPath), root = resolve(storage.directory);
  if (brain === root || brain.startsWith(root + "/")) throw new Error("Native observation storage must not contain the brain.");
  await directory(root, brain);
  const identity = digest(JSON.stringify([brain, storage.sessionId]));
  return { path: join(root, identity + ".json"), identity };
}
function validVersion(value: unknown): value is NativeFileVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as NativeFileVersion;
  return version.status === "known" ? /^[a-f0-9]{64}$/.test(version.hash) : version.status === "missing" || version.status === "unavailable";
}
export async function loadNativeObservations(storage: NativeObservationStorage): Promise<RecordData | undefined> {
  const { path, identity } = await location(storage);
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Invalid native observation storage file.");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error("Native observation storage exceeds its byte bound.");
    const value = JSON.parse(bytes.toString()) as RecordData & { schema: number; identity: string };
    if (value.schema !== 1 || value.identity !== identity || typeof value.incomplete !== "boolean" || !Array.isArray(value.observed)
      || !value.observed.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && validVersion(entry[1]))
      || new Set(value.observed.map(entry => entry[0])).size !== value.observed.length) throw new Error("Invalid native observation record.");
    return value;
  } finally { await handle.close(); }
}
export async function saveNativeObservations(storage: NativeObservationStorage, value: RecordData): Promise<void> {
  const { path, identity } = await location(storage);
  const bytes = JSON.stringify({ schema: 1, identity, ...value });
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Native observation storage exceeds its byte bound.");
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Replacing a leaf never mutates a linked inode or follows a symlink.
    await directory(dirname(path), await realpath(storage.brainPath));
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temp, { force: true }); }
}
