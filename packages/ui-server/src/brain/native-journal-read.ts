/** Descriptor-relative access to a pinned sealed root, never to live brain paths. */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";

export interface NativeJournalReadContext {
  checkpointId: string;
  workerUid: number;
  manager: Pick<ReturnType<typeof createNativeBrainManagerClient>, "readCheckpoint">;
  signal?: AbortSignal;
  createTemporary(maximum: number): Promise<{ file: FileHandle; release(): void }>;
}

export const nativeJournalPermissionDenied = (error: unknown): boolean =>
  ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "");

export async function openNativeJournalFile(root: string, path: string): Promise<FileHandle> {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\0") || parts.some(part => !part || part === "." || part === "..")) throw new Error("Invalid native journal path.");
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const file = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Native journal input is not a regular file.");
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { await directory.close(); }
}

/** A worker-readable private input is copied under the existing journal cap. */
export async function withNativeJournalFile<T>(root: string, path: string, maximum: number,
  context: NativeJournalReadContext | undefined, consume: (file: FileHandle) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid native journal read bound.");
  let direct: FileHandle;
  try { direct = await openNativeJournalFile(root, path); }
  catch (error) {
    if (!context || !nativeJournalPermissionDenied(error)) throw error;
    context.signal?.throwIfAborted();
    const temporary = await context.createTemporary(maximum);
    try {
      const copy = await context.manager.readCheckpoint(context.checkpointId, path, maximum, context.workerUid, context.signal);
      const reader = copy.stream.getReader(); let offset = 0;
      try {
        for (;;) {
          context.signal?.throwIfAborted();
          const part = await reader.read(); if (part.done) break;
          if (offset + part.value.byteLength > maximum) throw new Error("Private native journal input exceeds its read bound.");
          let written = 0;
          while (written < part.value.byteLength) {
            context.signal?.throwIfAborted();
            const result = await temporary.file.write(part.value, written, part.value.byteLength - written, offset + written);
            if (!result.bytesWritten) throw new Error("Private native journal copy made no progress.");
            written += result.bytesWritten;
          }
          offset += written;
        }
        const receipt = await copy.completed;
        if (receipt.bytes !== offset || receipt.workerUid !== context.workerUid) throw new Error("Private native journal reader completion differs from its copy.");
      } finally { await reader.cancel(); await copy.completed.catch(() => {}); }
      context.signal?.throwIfAborted();
      return await consume(temporary.file);
    } finally { await temporary.file.close(); temporary.release(); }
  }
  try { return await consume(direct); } finally { await direct.close(); }
}

export async function readNativeJournalFile(root: string, path: string, maximum: number, context?: NativeJournalReadContext): Promise<Buffer> {
  return withNativeJournalFile(root, path, maximum, context, async file => {
    const size = (await file.stat()).size;
    if (size > maximum) throw new Error("Native journal input exceeds its read bound.");
    const result = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(result, offset, Math.min(64 * 1024, size - offset), offset);
      if (!bytesRead) throw new Error("Native journal input ended before its sealed size.");
      offset += bytesRead;
    }
    return result;
  });
}
