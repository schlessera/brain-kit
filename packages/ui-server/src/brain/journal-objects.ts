/** Private streamed content objects; a durable journal ledger owns every reservation. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import * as fs from "node:fs";
import { promisify } from "node:util";

export interface JournalObjectReservation {
  readonly id?: string;
  /** Convert an in-flight reservation to one retained object, or release a deduplicated copy. */
  finish(hash: string, bytes: number, alreadyPresent: boolean): void;
  cancel(): void;
}
export interface JournalObjectAccounting {
  reserve(bytes: number, hash: string): JournalObjectReservation;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const readAsync = promisify(fs.read);
const writeAsync = promisify(fs.write);
const openAsync = promisify(fs.open);
const closeAsync = promisify(fs.close);
const syncAsync = promisify(fs.fsync);
const linkAsync = promisify(fs.link);
const unlinkAsync = promisify(fs.unlink);
const HASH = /^[a-f0-9]{64}$/;

export class JournalCapacityError extends Error {
  readonly reason = "journal_capacity";
  constructor(message: string = "The change journal cannot retain this observation within its storage cap.") { super(message); }
}

/** No brain pathname reaches this store. Only checked source descriptors and sha256 object names do. */
export function createJournalObjects(root: string, accounting: JournalObjectAccounting): {
  has(hash: string): boolean;
  putFileAsync(source: number, size: number, signal?: AbortSignal): Promise<string>;
  putBytes(bytes: Uint8Array): string;
  read(hash: string, maxBytes: number): Buffer;
  verify(hash: string, bytes: number): boolean;
  withVerifiedCopy<T>(hash: string, bytes: number, apply: (copy: (destination: number) => void) => T): T;
  discardPending(id: string): void;
  stream(hash: string, released: () => void): { body: ReadableStream<Uint8Array>; bytes: number };
  remove(hash: string): void;
  close(): void;
} {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = openSync(root, DIRECTORY);
  if ((fstatSync(directory).mode & 0o077) !== 0) { closeSync(directory); throw new Error("Journal object storage must be host-private."); }
  const path = (name: string) => `/proc/self/fd/${directory}/${name}`;
  let closed = false;
  function assertOpen() { if (closed) throw new Error("Journal object storage is closed."); }
  function openObject(hash: string): number {
    assertOpen(); if (!HASH.test(hash)) throw new Error("Invalid journal object identifier.");
    const fd = openSync(path(hash), READ);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) { closeSync(fd); throw new Error("Journal object is not a private regular file."); }
    return fd;
  }
  const has = (hash: string): boolean => {
    let fd: number | undefined;
    try { fd = openObject(hash); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  return {
    has,
    putBytes(bytes) {
      assertOpen();
      const digest = createHash("sha256").update(bytes).digest("hex");
      const reservation = accounting.reserve(bytes.length, digest);
      const temporary = `pending-${reservation.id ?? crypto.randomUUID()}`;
      let output: number | undefined, created = false, published = false;
      try {
        output = openSync(path(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
        if (output !== undefined) {
          let position = 0;
          while (position < bytes.length) { const count = writeSync(output, bytes, position, Math.min(64 * 1024, bytes.length - position), position); if (!count) throw new Error("Journal object write made no progress."); position += count; }
          fsyncSync(output); closeSync(output); output = undefined; fsyncSync(directory);
        }
        let duplicate = false;
        try { fs.linkSync(path(temporary), path(digest)); published = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !has(digest)) throw error; duplicate = true; }
        unlinkSync(path(temporary)); created = false; fsyncSync(directory);
        reservation.finish(digest, bytes.length, duplicate);
        return digest;
      } catch (error) {
        if (output !== undefined) closeSync(output);
        if (created) unlinkSync(path(temporary));
        if (!published) reservation.cancel(); throw error;
      }
    },
    async putFileAsync(source, size, signal) {
      assertOpen(); signal?.throwIfAborted();
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid journal object size.");
      const info = fstatSync(source);
      if (!info.isFile() || info.size !== size) throw new Error("Journal source changed before its storage reservation.");
      // The caller pins a sealed native checkpoint and this descriptor until
      // completion. Each read/write yields; large changed files cannot monopolize
      // the server loop. Admission and publication retain the existing ledger.
      async function digestSource(output?: number): Promise<string> {
        const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
        let position = 0;
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await readAsync(source, chunk, 0, Math.min(chunk.length, size - position + 1), position);
          if (!bytesRead) break;
          if (position + bytesRead > size) throw new Error("Journal source grew during capture.");
          hash.update(chunk.subarray(0, bytesRead));
          if (output !== undefined) {
            let written = 0;
            while (written < bytesRead) {
              signal?.throwIfAborted();
              const { bytesWritten } = await writeAsync(output, chunk, written, bytesRead - written, position + written);
              if (!bytesWritten) throw new Error("Journal object write made no progress.");
              written += bytesWritten;
            }
          }
          position += bytesRead;
        }
        if (position !== size) throw new Error("Journal source shrank during capture.");
        return hash.digest("hex");
      }
      const expectedHash = await digestSource();
      signal?.throwIfAborted();
      const reservation = accounting.reserve(size, expectedHash);
      const name = `pending-${reservation.id ?? crypto.randomUUID()}`;
      let output: number | undefined, present = false, published = false;
      try {
        output = await openAsync(path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        present = true;
        const digest = await digestSource(output);
        await syncAsync(output); await closeAsync(output); output = undefined;
        if (digest !== expectedHash) throw new Error("Journal source changed between identity and content capture.");
        let duplicate = false;
        try { await linkAsync(path(name), path(digest)); published = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !has(digest)) throw error; duplicate = true; }
        await unlinkAsync(path(name)); present = false;
        await syncAsync(directory);
        reservation.finish(digest, size, duplicate);
        return digest;
      } catch (error) {
        if (output !== undefined) await closeAsync(output);
        if (present) await unlinkAsync(path(name));
        if (!published) reservation.cancel();
        throw error;
      }
    },
    read(hash, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid journal read bound.");
      const fd = openObject(hash);
      try {
        const size = fstatSync(fd).size;
        if (size > maxBytes) throw new Error("Journal object exceeds the requested read bound.");
        const bytes = Buffer.alloc(size);
        let position = 0;
        while (position < size) {
          const length = readSync(fd, bytes, position, size - position, position);
          if (!length) throw new Error("Journal object ended before its recorded size.");
          position += length;
        }
        if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Journal object integrity check failed.");
        return bytes;
      } finally { closeSync(fd); }
    },
    verify(hash, bytes) {
      const fd = openObject(hash);
      try {
        if (fstatSync(fd).size !== bytes) return false;
        const digest = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
        let position = 0;
        while (position < bytes) {
          const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - position), position);
          if (!count) return false;
          digest.update(chunk.subarray(0, count)); position += count;
        }
        return digest.digest("hex") === hash;
      } finally { closeSync(fd); }
    },
    discardPending(id) {
      assertOpen(); if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid journal reservation identifier.");
      try { unlinkSync(path(`pending-${id}`)); fsyncSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
    withVerifiedCopy(hash, bytes, apply) {
      const fd = openObject(hash);
      try {
        if (fstatSync(fd).size !== bytes) throw new Error("Retained version size changed.");
        const buffer = Buffer.allocUnsafe(64 * 1024), digest = createHash("sha256"); let position = 0;
        while (position < bytes) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
          if (!count) throw new Error("Retained version is incomplete.");
          digest.update(buffer.subarray(0, count)); position += count;
        }
        if (digest.digest("hex") !== hash) throw new Error("Retained version checksum changed.");
        return apply(destination => {
          let position = 0;
          while (position < bytes) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
            if (!count) throw new Error("Retained version is incomplete.");
            let written = 0;
            while (written < count) written += writeSync(destination, buffer, written, count - written, position + written);
            position += count;
          }
        });
      } finally { closeSync(fd); }
    },
    stream(hash, released) {
      const fd = openObject(hash), bytes = fstatSync(fd).size;
      let position = 0, ended = false;
      const digest = createHash("sha256");
      const finish = () => { if (!ended) { ended = true; closeSync(fd); released(); } };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          try {
            if (position === bytes) {
              if (digest.digest("hex") !== hash) throw new Error("Journal object integrity check failed.");
              finish(); controller.close(); return;
            }
            const chunk = Buffer.alloc(Math.min(64 * 1024, bytes - position));
            const count = readSync(fd, chunk, 0, chunk.length, position);
            if (!count) throw new Error("Journal object ended before its recorded size.");
            const observed = chunk.subarray(0, count); digest.update(observed); position += count; controller.enqueue(observed);
          } catch (error) { finish(); controller.error(error); }
        },
        cancel() { finish(); },
      });
      return { body, bytes };
    },
    remove(hash) { assertOpen(); if (!HASH.test(hash)) throw new Error("Invalid journal object identifier."); unlinkSync(path(hash)); },
    close() { if (!closed) { closed = true; closeSync(directory); } },
  };
}
