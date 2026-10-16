/** Retained, authorized roots only. Recovery is best effort after owned-tree cleanup. */
import { resolve } from "node:path";
import { processStateLedger, type Reservation } from "./worker-state-budget.js";
import { hostOutputStagingLimits } from "./worker-state-limits.js";

interface Entry { name: string; type: "file" | "directory"; size: number; mode: number }
type Request = <T extends object>(operation: string, input?: object) => T;
type AsyncRequest = <T extends object>(operation: string, input?: object, signal?: AbortSignal) => Promise<T>;
interface Root { name: "state" | "temp"; bytes: number; request: Request; requestAsync: AsyncRequest; cache: Map<string, Buffer>; cachedBytes: number; inflightBytes: number; activeReads: number; fullCopy: boolean; closed: boolean; cleanupConfirmed: boolean; abort: AbortController; inventory?: string[]; recovery?: Reservation }
const roots = new Map<string, Root>();

export function registerIdentityReadRoot(root: string, name: "state" | "temp", bytes: number, request: Request, requestAsync: AsyncRequest): { close(): void; confirmCleanup(): void } {
  if (roots.has(root)) throw new Error("worker_identity_root_already_registered");
  const held: Root = { name, bytes, request, requestAsync, cache: new Map(), cachedBytes: 0, inflightBytes: 0, activeReads: 0, fullCopy: false,
    closed: false, cleanupConfirmed: false, abort: new AbortController() };
  roots.set(root, held);
  return {
    close() { if (held.closed) return; held.closed = true; roots.delete(root); held.abort.abort(new DOMException("Retained worker root closed", "AbortError")); finishRecovery(held); },
    confirmCleanup() { held.cleanupConfirmed = true; finishRecovery(held); },
  };
}

function finishRecovery(root: Root): void {
  if (root.closed && !root.activeReads && !root.inflightBytes && !root.fullCopy) {
    root.cache.clear(); root.cachedBytes = 0;
    if (root.cleanupConfirmed) root.recovery?.release();
  }
}

function authorized(path: string) {
  if (!path.startsWith("/")) return undefined;
  if (roots.size === 0) return undefined;
  if (path.includes("\0") || path.split("/").slice(1).some(part => !part || part === "." || part === ".."))
    throw new Error("worker_identity_path_alias_refused");
  const normalized = resolve(path);
  for (const [root, value] of roots) if (normalized === root || normalized.startsWith(root + "/"))
    return { ...value, held: value, path: normalized.slice(root.length + 1) };
  return undefined;
}

function admitRecovery(root: Root): void {
  if (root.recovery) return;
  const limits = hostOutputStagingLimits();
  try { root.recovery = processStateLedger().reserve(undefined, undefined, { allowanceBytes: root.bytes, budgetBytes: limits.budgetBytes }); }
  catch {
    throw new Error("worker_identity_recovery_capacity_unavailable: configured output-staging budget is busy; this turn already executed and its private output was not recovered");
  }
}

function claimCopy(root: Root, bytes: number): void {
  if (root.closed) throw new Error("worker_identity_recovery_root_closed");
  if (root.cachedBytes + root.inflightBytes + bytes > root.bytes) throw new Error("worker_identity_recovery_exceeds_aggregate_allowance");
  root.inflightBytes += bytes;
}

function retainCopy(root: Root, name: string, bytes: Buffer): void {
  if (root.closed) throw new Error("worker_identity_recovery_root_closed");
  root.cachedBytes += bytes.length - (root.cache.get(name)?.length ?? 0);
  root.cache.set(name, bytes);
}

export function hasIdentityReadRoot(path: string): boolean { return authorized(path) !== undefined; }

function decodeChunk(data: unknown): Buffer {
  if (typeof data !== "string" || data.length > 43692) throw new Error("worker_identity_invalid_read_chunk");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > 32768 || bytes.toString("base64") !== data) throw new Error("worker_identity_invalid_read_chunk");
  return bytes;
}

/** No arbitrary host file can be sent to the fixed worker-UID reader. */
export function recoveredWorkerFile(path: string, maxBytes: number): Buffer | undefined {
  const held = authorized(path);
  if (!held) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("worker_identity_invalid_read_bound");
  maxBytes = Math.min(maxBytes, held.bytes);
  admitRecovery(held.held);
  const saved = held.cache.get(held.path);
  if (saved !== undefined) {
    if (saved.length > maxBytes) throw new Error("worker_identity_read_exceeds_bound");
    return saved;
  }
  if (held.held.fullCopy) throw new Error("worker_identity_recovery_already_in_progress");
  let captured: Buffer | undefined;
  let offset = 0, size: number | undefined;
  let claimed = 0;
  try {
  do {
    const reply = held.request<{ data: string; size: number }>("read", { root: held.name, path: held.path, maxBytes, offset, chunkBytes: Math.max(1, Math.min(32768, maxBytes - offset)) });
    if (!Number.isSafeInteger(reply.size) || reply.size < 0 || reply.size > maxBytes || (size !== undefined && reply.size !== size))
      throw new Error("worker_identity_read_size_changed_or_exceeds_bound");
    size = reply.size;
    if (!captured) { claimCopy(held.held, size); claimed = size; captured = Buffer.alloc(size); }
    const bytes = decodeChunk(reply.data);
    if (bytes.length > 32768 || offset + bytes.length > size || (!bytes.length && offset < size))
      throw new Error("worker_identity_invalid_read_chunk");
    bytes.copy(captured, offset); offset += bytes.length;
  } while (offset < size!);
  retainCopy(held.held, held.path, captured!);
  return captured!;
  } finally { held.held.inflightBytes -= claimed; finishRecovery(held.held); }
}

/** Enumerates only regular, unaliased entries below one retained mount. */
export function recoveredWorkerFiles(path: string): string[] | undefined {
  const held = authorized(path);
  if (!held) return undefined;
  if (held.inventory !== undefined) return held.inventory.filter(name => !held.path || name.startsWith(held.path + "/")).map(name => held.path ? name.slice(held.path.length + 1) : name);
  const found: string[] = [];
  let visited = 0;
  function visit(suffix: string, depth: number) {
    if (depth > 128) throw new Error("worker_identity_directory_depth_exceeds_bound");
    const current = [held!.path, suffix].filter(Boolean).join("/");
    const reply = held!.request<{ entries: Entry[] }>("read", { root: held!.name, path: current, action: "list", maxBytes: held!.bytes });
    if (!Array.isArray(reply.entries)) throw new Error("worker_identity_invalid_directory_reply");
    for (const entry of reply.entries) {
      if (++visited > 10000) throw new Error("worker_identity_entry_count_exceeds_bound");
      if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\0"))
        throw new Error("worker_identity_invalid_directory_entry");
      const relative = [suffix, entry.name].filter(Boolean).join("/");
      if (entry.type === "directory") visit(relative, depth + 1);
      else if (entry.type === "file") found.push(relative);
      else throw new Error("worker_identity_special_file_refused");
      if (found.length > 10000) throw new Error("worker_identity_file_count_exceeds_bound");
    }
  }
  visit("", 0);
  return found;
}

/** Cancellable copy-out preparation; each bounded packet yields to the server event loop. */
export async function prepareRecoveredWorkerFiles(path: string, signal?: AbortSignal): Promise<boolean> {
  const root = authorized(path);
  if (!root) return false;
  signal = signal ? AbortSignal.any([signal, root.held.abort.signal]) : root.held.abort.signal;
  if (root.path) throw new Error("worker_identity_recovery_requires_retained_root");
  if (root.held.inventory !== undefined) return true;
  if (root.held.fullCopy || root.held.activeReads || root.held.inflightBytes || root.held.cachedBytes) throw new Error("worker_identity_recovery_already_in_progress");
  admitRecovery(root.held);
  root.held.fullCopy = true;
  const files: string[] = [];
  const captured = new Map<string, Buffer>();
  let total = 0, visited = 0, claimed = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > 128) throw new Error("worker_identity_directory_depth_exceeds_bound");
    const reply = await root!.requestAsync<{ entries: Entry[] }>("read", { root: root!.name, path: directory, action: "list", maxBytes: root!.bytes }, signal);
    if (!Array.isArray(reply.entries)) throw new Error("worker_identity_invalid_directory_reply");
    for (const entry of reply.entries) {
      if (++visited > 10000) throw new Error("worker_identity_entry_count_exceeds_bound");
      signal?.throwIfAborted();
      if (typeof entry.name !== "string" || !entry.name || [".", ".."].includes(entry.name) || /[/\0]/.test(entry.name)) throw new Error("worker_identity_invalid_directory_entry");
      const name = [directory, entry.name].filter(Boolean).join("/");
      if (entry.type === "directory") await visit(name, depth + 1);
      else if (entry.type === "file") {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || total + entry.size > root!.bytes) throw new Error("worker_identity_recovery_exceeds_allowance");
        claimCopy(root!.held, entry.size); claimed += entry.size;
        const capturedBytes = Buffer.alloc(entry.size);
        let offset = 0;
        do {
          signal?.throwIfAborted();
          const next = await root!.requestAsync<{ data: string; size: number }>("read", { root: root!.name, path: name, maxBytes: root!.bytes - total,
            offset, chunkBytes: 32768 }, signal);
          const bytes = decodeChunk(next.data);
          if (next.size !== entry.size || bytes.length > 32768 || offset + bytes.length > entry.size || (!bytes.length && offset < entry.size))
            throw new Error("worker_identity_recovery_source_changed");
          bytes.copy(capturedBytes, offset); offset += bytes.length;
        } while (offset < entry.size);
        captured.set(name, capturedBytes); total += offset; files.push(name);
        if (files.length > 10000) throw new Error("worker_identity_file_count_exceeds_bound");
      } else throw new Error("worker_identity_special_file_refused");
    }
  }
  try {
    await visit("", 0);
    signal?.throwIfAborted();
    if (root.held.closed) throw new Error("worker_identity_recovery_root_closed");
    root.held.cache = captured; root.held.cachedBytes = total; root.held.inventory = files;
    return true;
  } finally { root.held.inflightBytes -= claimed; root.held.fullCopy = false; finishRecovery(root.held); }
}

/** Prepare one referenced temp file without traversing unrelated caches or nested mounts. */
export async function prepareRecoveredWorkerFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<number | undefined> {
  const root = authorized(path);
  if (!root) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("worker_identity_invalid_read_bound");
  signal = signal ? AbortSignal.any([signal, root.held.abort.signal]) : root.held.abort.signal;
  signal?.throwIfAborted();
  admitRecovery(root.held);
  maxBytes = Math.min(maxBytes, root.bytes);
  const saved = root.held.cache.get(root.path);
  if (saved !== undefined) {
    if (saved.length > maxBytes) throw new Error("worker_identity_recovery_exceeds_bound");
    return saved.length;
  }
  if (root.held.fullCopy) throw new Error("worker_identity_recovery_already_in_progress");
  root.held.activeReads++;
  let claimed = 0;
  try {
  const metadata = await root.requestAsync<{ type: string; size: number }>("read", { root: root.name, path: root.path, action: "stat", maxBytes }, signal);
  if (metadata.type !== "file" || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes)
    throw new Error("worker_identity_recovery_exceeds_bound");
  claimCopy(root.held, metadata.size);
  claimed = metadata.size;
  const capturedBytes = Buffer.alloc(metadata.size);
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const next = await root.requestAsync<{ data: string; size: number }>("read", { root: root.name, path: root.path, maxBytes, offset, chunkBytes: 32768 }, signal);
    const bytes = decodeChunk(next.data);
    if (next.size !== metadata.size || bytes.length > 32768 || offset + bytes.length > metadata.size || (!bytes.length && offset < metadata.size))
      throw new Error("worker_identity_recovery_source_changed");
    bytes.copy(capturedBytes, offset); offset += bytes.length;
  } while (offset < metadata.size);
  signal?.throwIfAborted();
  retainCopy(root.held, root.path, capturedBytes);
  return offset;
  } finally { root.held.inflightBytes -= claimed; root.held.activeReads--; finishRecovery(root.held); }
}
