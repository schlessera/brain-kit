/** Private streamed content objects; a durable journal ledger owns every reservation. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import type { JournalSnapshotObjects } from "./journal-snapshot.js";

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
const HASH = /^[a-f0-9]{64}$/;

export class JournalCapacityError extends Error {
  readonly reason = "journal_capacity";
  constructor(message: string = "The change journal cannot retain this observation within its storage cap.") { super(message); }
}

/** No brain pathname reaches this store. Only checked source descriptors and sha256 object names do. */
export function createJournalObjects(root: string, accounting: JournalObjectAccounting): JournalSnapshotObjects & {
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
    putFile(source, size) {
      assertOpen();
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid journal object size.");
      const info = fstatSync(source);
      if (!info.isFile() || info.size !== size) throw new Error("Journal source changed before its storage reservation.");
      // Precompute the identity so the same transaction can allocate final
      // object metadata and reserve its bytes before any temporary disk write.
      const initialHash = createHash("sha256"), initialChunk = Buffer.alloc(64 * 1024);
      let initialBytes = 0;
      for (;;) {
        const count = readSync(source, initialChunk, 0, Math.min(initialChunk.length, size - initialBytes + 1), initialBytes);
        if (!count) break;
        if (initialBytes + count > size) throw new Error("Journal source grew before storage admission.");
        initialHash.update(initialChunk.subarray(0, count)); initialBytes += count;
      }
      if (initialBytes !== size) throw new Error("Journal source shrank before storage admission.");
      const expectedHash = initialHash.digest("hex");
      // Reserve before creating a temporary file; duplicates occupy temporary space until discarded too.
      const reservation = accounting.reserve(size, expectedHash);
      const name = `pending-${reservation.id ?? crypto.randomUUID()}`;
      let output: number | undefined;
      let present = false;
      let published = false;
      try {
        output = openSync(path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        present = true;
        const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
        let bytes = 0;
        for (;;) {
          const length = readSync(source, chunk, 0, Math.min(chunk.length, size - bytes + 1), bytes);
          if (!length) break;
          if (bytes + length > size) throw new Error("Journal source grew during its bounded copy.");
          hash.update(chunk.subarray(0, length));
          let written = 0;
          while (written < length) {
            const count = writeSync(output, chunk, written, length - written);
            if (!count) throw new Error("Journal object write made no progress.");
            written += count;
          }
          bytes += length;
        }
        if (bytes !== size) throw new Error("Journal source shrank during its bounded copy.");
        fsyncSync(output); closeSync(output); output = undefined;
        const digest = hash.digest("hex");
        if (digest !== expectedHash) throw new Error("Journal source changed between identity and content capture.");
        let duplicate = false;
        try { linkSync(path(name), path(digest)); published = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!has(digest)) throw error; duplicate = true; }
        unlinkSync(path(name)); present = false;
        fsyncSync(directory);
        reservation.finish(digest, size, duplicate);
        return digest;
      } catch (error) {
        if (output !== undefined) closeSync(output);
        if (present) unlinkSync(path(name));
        // A published object whose ledger commit failed stays charged by its
        // pending reservation until recovery; never leave unaccounted bytes.
        if (!published) reservation.cancel(); throw error;
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
