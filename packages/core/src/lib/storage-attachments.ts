/** Narrow raw attachment operations. Callers own approval, retained recovery and writer coordination. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync } from "node:fs";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const STORAGE_ATTACHMENT_LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024, pathBytes: 4096, depth: 32, milliseconds: 15_000 });
export interface StorageAttachmentVersion { hash: string; bytes: number; mode: number; identity: string; parents: string[] }
export class StorageAttachmentRefusal extends Error {
  constructor(readonly reason: "unsupported" | "protected" | "changed" | "too_large" | "occupied" | "unavailable") { super(reason); }
}
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const read = promisify(fs.read);
const EXTENSIONS = /\.(?:pdf|png|jpe?g|gif|webp|avif|heic|tiff?|bmp|ico|mp3|m4a|wav|ogg|flac|aac|mp4|webm|mov|mkv|avi|zip|7z|gz|bz2|xz|docx|xlsx|pptx|odt|ods|odp|epub)$/i;

export function storageAttachmentPath(path: string): boolean {
  const parts = path.split("/"), folded = parts.map(part => part.normalize("NFKC").toLowerCase());
  return Buffer.byteLength(path) <= STORAGE_ATTACHMENT_LIMITS.pathBytes && parts.length <= STORAGE_ATTACHMENT_LIMITS.depth
    && !/[\\\u0000-\u001f\u007f]/u.test(path) && parts.every(part => !!part) && folded.every(part => !part.startsWith("."))
    && !folded.some(part => ["node_modules", "workspaces", "scripts"].includes(part))
    && !(folded[0] === "context" && folded[1] === "policies") && EXTENSIONS.test(path);
}
function mount(fd: number): string {
  const id = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^mnt_id:\s*(\d+)$/m)?.[1];
  if (!id) throw new StorageAttachmentRefusal("unsupported");
  return id;
}
const identity = (fd: number) => { const s = fstatSync(fd, { bigint: true }); return [s.dev, s.ino, s.mode, mount(fd)].join(":"); };
const stamp = (fd: number) => { const s = fstatSync(fd, { bigint: true }); return [identity(fd), s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":"); };
function openParent(root: string, path: string) {
  if (process.platform !== "linux") throw new StorageAttachmentRefusal("unsupported");
  if (!storageAttachmentPath(path)) throw new StorageAttachmentRefusal("protected");
  if (resolve(root) !== root || realpathSync(root) !== root) throw new StorageAttachmentRefusal("changed");
  const fds: number[] = [], chain: { parent: number; name: string; child: number }[] = [];
  try {
    const first = openSync(root, DIRECTORY); fds.push(first);
    const parts = path.split("/"), name = parts.pop()!, firstMount = mount(first);
    let parent = first;
    for (const part of parts) {
      const child = openSync(at(parent, part), DIRECTORY); fds.push(child);
      if (mount(child) !== firstMount) throw new StorageAttachmentRefusal("protected");
      chain.push({ parent, name: part, child }); parent = child;
    }
    const parents = fds.map(identity);
    const verify = () => {
      const live = lstatSync(root, { bigint: true }), held = fstatSync(first, { bigint: true });
      if (!live.isDirectory() || live.dev !== held.dev || live.ino !== held.ino) throw new StorageAttachmentRefusal("changed");
      for (const entry of chain) {
        const named = lstatSync(at(entry.parent, entry.name), { bigint: true }), opened = fstatSync(entry.child, { bigint: true });
        if (!named.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino) throw new StorageAttachmentRefusal("changed");
      }
      if (JSON.stringify(fds.map(identity)) !== JSON.stringify(parents)) throw new StorageAttachmentRefusal("changed");
    };
    return { parent, name, parents, mount: firstMount, verify, close() { for (const fd of fds.reverse()) closeSync(fd); } };
  } catch (error) { for (const fd of fds.reverse()) closeSync(fd); throw error; }
}
function fileFacts(fd: number, volume: string) {
  const info = fstatSync(fd, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o7111n) !== 0n || mount(fd) !== volume) throw new StorageAttachmentRefusal("protected");
  if (info.size > BigInt(STORAGE_ATTACHMENT_LIMITS.fileBytes)) throw new StorageAttachmentRefusal("too_large");
  return { bytes: Number(info.size), mode: Number(info.mode & 0o7777n) };
}
async function digest(fd: number, bytes: number, signal?: AbortSignal): Promise<string> {
  const started = Date.now(), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() - started > STORAGE_ATTACHMENT_LIMITS.milliseconds) throw new StorageAttachmentRefusal("unavailable");
    const { bytesRead } = await read(fd, buffer, 0, Math.min(buffer.length, bytes - offset + 1), offset);
    if (!bytesRead) break;
    if (offset + bytesRead > bytes) throw new StorageAttachmentRefusal("changed");
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  if (offset !== bytes) throw new StorageAttachmentRefusal("changed");
  return hash.digest("hex");
}
async function opened(root: string, path: string, signal?: AbortSignal) {
  const parent = openParent(root, path); let fd: number | undefined;
  try {
    fd = openSync(at(parent.parent, parent.name), FILE);
    const facts = fileFacts(fd, parent.mount), initial = stamp(fd), hash = await digest(fd, facts.bytes, signal);
    parent.verify();
    if (stamp(fd) !== initial) throw new StorageAttachmentRefusal("changed");
    const named = lstatSync(at(parent.parent, parent.name), { bigint: true }), held = fstatSync(fd, { bigint: true });
    if (!named.isFile() || named.dev !== held.dev || named.ino !== held.ino) throw new StorageAttachmentRefusal("changed");
    const version: StorageAttachmentVersion = { ...facts, hash, identity: initial, parents: parent.parents };
    return { parent, fd, version, close() { closeSync(fd!); parent.close(); } };
  } catch (error) { if (fd !== undefined) closeSync(fd); parent.close(); throw error; }
}
export async function inspectStorageAttachment(root: string, path: string, signal?: AbortSignal): Promise<StorageAttachmentVersion> {
  const held = await opened(root, path, signal);
  try { return held.version; } finally { held.close(); }
}
function expectedVersion(value: StorageAttachmentVersion): void {
  if (!/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > STORAGE_ATTACHMENT_LIMITS.fileBytes
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || (value.mode & ~0o666) !== 0 || !Array.isArray(value.parents)
    || value.parents.length < 1 || value.parents.length > STORAGE_ATTACHMENT_LIMITS.depth || value.parents.some(part => typeof part !== "string" || part.length > 256)
    || typeof value.identity !== "string" || value.identity.length > 512) throw new StorageAttachmentRefusal("unsupported");
}
/** Approval and verified retained bytes must already be durable; hold the exclusive writer gate throughout. */
export async function removeStorageAttachment(root: string, path: string, expected: StorageAttachmentVersion, signal?: AbortSignal, assertCurrent?: () => void): Promise<void> {
  expectedVersion(expected);
  const held = await opened(root, path, signal);
  try {
    signal?.throwIfAborted(); held.parent.verify();
    if (JSON.stringify(held.version) !== JSON.stringify(expected) || stamp(held.fd) !== expected.identity) throw new StorageAttachmentRefusal("changed");
    const named = lstatSync(at(held.parent.parent, held.parent.name), { bigint: true }), info = fstatSync(held.fd, { bigint: true });
    if (!named.isFile() || named.dev !== info.dev || named.ino !== info.ino || named.nlink !== 1n) throw new StorageAttachmentRefusal("changed");
    assertCurrent?.(); signal?.throwIfAborted();
    unlinkSync(at(held.parent.parent, held.parent.name)); fsyncSync(held.parent.parent);
  } finally { held.close(); }
}
/** Caller leases and verifies the original through its existing recovery owner. Never replaces a present entry. */
export function restoreStorageAttachment(root: string, path: string, expected: StorageAttachmentVersion, copy: (fd: number) => void, assertCurrent?: () => void): void {
  expectedVersion(expected);
  const parent = openParent(root, path); let fd: number | undefined, complete = false;
  try {
    parent.verify();
    if (JSON.stringify(parent.parents) !== JSON.stringify(expected.parents)) throw new StorageAttachmentRefusal("changed");
    if (lstatSync(at(parent.parent, parent.name), { throwIfNoEntry: false })) throw new StorageAttachmentRefusal("occupied");
    assertCurrent?.();
    fd = openSync(at(parent.parent, parent.name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    copy(fd);
    const facts = fileFacts(fd, parent.mount), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let offset = 0; const started = Date.now();
    for (;;) {
      assertCurrent?.();
      if (Date.now() - started > STORAGE_ATTACHMENT_LIMITS.milliseconds) throw new StorageAttachmentRefusal("unavailable");
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, expected.bytes - offset + 1), offset);
      if (!length) break;
      if (offset + length > expected.bytes) throw new StorageAttachmentRefusal("changed");
      hash.update(buffer.subarray(0, length)); offset += length;
    }
    if (facts.bytes !== expected.bytes || offset !== expected.bytes || hash.digest("hex") !== expected.hash) throw new StorageAttachmentRefusal("changed");
    parent.verify();
    const live = lstatSync(at(parent.parent, parent.name)), held = fstatSync(fd);
    if (!live.isFile() || live.dev !== held.dev || live.ino !== held.ino) throw new StorageAttachmentRefusal("changed");
    fchmodSync(fd, expected.mode); fsyncSync(fd); fsyncSync(parent.parent); complete = true;
  } finally {
    try { if (fd !== undefined) {
      try {
        if (!complete) {
          const live = lstatSync(at(parent.parent, parent.name), { throwIfNoEntry: false }), held = fstatSync(fd);
          if (live?.isFile() && live.dev === held.dev && live.ino === held.ino) { unlinkSync(at(parent.parent, parent.name)); fsyncSync(parent.parent); }
        }
      } finally { closeSync(fd); }
    } } finally { parent.close(); }
  }
}

/** Checks the exact reviewed parent chain and absence, without creating a replacement. */
export function storageAttachmentVacant(root: string, path: string, expected: StorageAttachmentVersion): boolean {
  expectedVersion(expected); const parent = openParent(root, path);
  try { parent.verify(); return JSON.stringify(parent.parents) === JSON.stringify(expected.parents) && !lstatSync(at(parent.parent, parent.name), { throwIfNoEntry: false }); }
  finally { parent.close(); }
}
