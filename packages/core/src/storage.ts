/** Supported metadata-only reader for host shells; never invokes Git or the brain CLI. */
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
