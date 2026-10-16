/** Supported Storage readers and narrow raw-file operations. Fact inspection evaluates Git and requires worker isolation in hosted consumers. */
import { isAbsolute } from "node:path";
import { collectStorageProcess } from "./lib/storage-process.js";
import type { StorageInventory } from "./lib/storage-inventory.js";
export type { StorageInventory } from "./lib/storage-inventory.js";
export interface StorageReadOptions {
  brainPath: string;
  /** Explicitly approved external local Git stores; at most sixteen roots. */
  gitRoots?: readonly string[];
  signal?: AbortSignal;
}
export async function readStorageInventory(options: StorageReadOptions): Promise<StorageInventory> {
  const paths = [options.brainPath, ...options.gitRoots ?? []];
  if (paths.length > 17 || paths.some(path => typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0"))) throw Error("Storage requires bounded absolute host roots.");
  return collectStorageProcess(options.brainPath, options.gitRoots ?? [], options.signal ?? new AbortController().signal, true);
}

export { STORAGE_ATTACHMENT_LIMITS, StorageAttachmentRefusal, storageAttachmentPath, inspectStorageAttachment, removeStorageAttachment, restoreStorageAttachment, storageAttachmentVacant } from "./lib/storage-attachments.js";
export type { StorageAttachmentVersion } from "./lib/storage-attachments.js";
export { inspectStorageAttachmentFacts } from "./lib/storage-attachment-facts.js";
export type { StorageAttachmentFacts } from "./lib/storage-attachment-facts.js";
