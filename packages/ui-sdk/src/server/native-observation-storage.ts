/** Host-owned integrity metadata. Never included in a worker transcript or brain index. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NativeFileVersion } from "./native-file-versions.js";

export interface NativeObservationStorage { directory: string; brainPath: string; sessionId: string }
interface RecordData { incomplete: boolean; observed: Array<[string, NativeFileVersion]> }
const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function directory(path: string, brain: string): void {
  if (path === brain || path.startsWith(brain + "/")) throw new Error("Native observations must be outside the brain.");
  try {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("Native observation storage is redirected.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    directory(dirname(path), brain);
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function location(storage: NativeObservationStorage): { path: string; identity: string } {
  const brain = realpathSync(storage.brainPath), root = resolve(storage.directory);
  if (brain === root || brain.startsWith(root + "/")) throw new Error("Native observation storage must not contain the brain.");
  directory(root, brain);
  const identity = digest(JSON.stringify([brain, storage.sessionId]));
  return { path: join(root, identity + ".json"), identity };
}
function validVersion(value: unknown): value is NativeFileVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as NativeFileVersion;
  return version.status === "known" ? /^[a-f0-9]{64}$/.test(version.hash) : version.status === "missing" || version.status === "unavailable";
}
export function loadNativeObservations(storage: NativeObservationStorage): RecordData | undefined {
  const { path, identity } = location(storage);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Invalid native observation storage file.");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw new Error("Native observation storage exceeds its byte bound.");
    const value = JSON.parse(bytes.toString()) as RecordData & { schema: number; identity: string };
    if (value.schema !== 1 || value.identity !== identity || typeof value.incomplete !== "boolean" || !Array.isArray(value.observed)
      || !value.observed.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && validVersion(entry[1]))
      || new Set(value.observed.map(entry => entry[0])).size !== value.observed.length) throw new Error("Invalid native observation record.");
    return value;
  } finally { closeSync(fd); }
}
export function saveNativeObservations(storage: NativeObservationStorage, value: RecordData): void {
  const { path, identity } = location(storage);
  const bytes = JSON.stringify({ schema: 1, identity, ...value });
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Native observation storage exceeds its byte bound.");
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Replacing a leaf never mutates a linked inode or follows a symlink.
    directory(dirname(path), realpathSync(storage.brainPath));
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}
