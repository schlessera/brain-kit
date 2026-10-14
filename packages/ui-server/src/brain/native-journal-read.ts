/** Descriptor-relative access to a pinned sealed root, never to live brain paths. */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

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

export async function readNativeJournalFile(root: string, path: string, maximum: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid native journal read bound.");
  const file = await openNativeJournalFile(root, path);
  try {
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
  } finally { await file.close(); }
}
