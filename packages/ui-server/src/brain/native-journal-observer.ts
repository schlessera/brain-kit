import { isJournalSteeringPath } from "./journal-steering.js";
/** One metadata index and rolling sealed roots; no initial content capture. */
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, readdir, readlink, type FileHandle } from "node:fs/promises";
import { parseNativeBrainDelta } from "@schlessera/brain-ui-sdk/internal";
import type { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { nativeJournalPermissionDenied } from "./native-journal-read.js";

/** Structural subset of the concrete private native manager/client. */
export interface NativeJournalCheckpoint {
  id: string; path: string; uuid: string; transaction: string; readOnly: true;
}
export interface NativeJournalManager {
  checkpoint(id: string, signal?: AbortSignal): Promise<NativeJournalCheckpoint>;
  delta(from: string, to: string, signal?: AbortSignal): Promise<{
    stream: ReadableStream<Uint8Array>; completed: Promise<{ exitCode: 0; bytes: number }>;
  }>;
  release(id: string, signal?: AbortSignal): Promise<unknown>;
  readCheckpoint?: ReturnType<typeof createNativeBrainManagerClient>["readCheckpoint"];
  statCheckpoint?: ReturnType<typeof createNativeBrainManagerClient>["statCheckpoint"];
  listCheckpoint?: ReturnType<typeof createNativeBrainManagerClient>["listCheckpoint"];
}
export interface NativeJournalMetadata {
  path: string; kind: "directory" | "file" | "symlink" | "other";
  mode: number; bytes: number; stamp: string; inode: string; target?: string;
}
export interface NativeJournalChange {
  path: string; before: NativeJournalMetadata | null; after: NativeJournalMetadata | null;
}
export interface NativeJournalUnreadable {
  path: string; bytes: number | null; mode?: number; kind?: NativeJournalMetadata["kind"];
  reason: "worker_reader_unavailable";
  ms: number;
}
export class NativeJournalObservationError extends Error {
  readonly reason = "native_journal_observation_unavailable";
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = (message: string): never => { throw new NativeJournalObservationError(message); };
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

function rawText(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); } catch { return unavailable("Native metadata contains a non-UTF-8 name or link target."); }
}
function metadata(path: string, info: BigIntStats, target?: string): NativeJournalMetadata {
  const bytes = Number(info.size);
  if (!Number.isSafeInteger(bytes) || bytes < 0) unavailable("Native metadata size exceeds its exact representation.");
  return Object.freeze({ path, kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
    // st_dev identifies a mounted checkpoint, not this brain's inode lineage.
    mode: Number(info.mode & 0o7777n), bytes, inode: `${info.ino}`,
    stamp: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, ...(target !== undefined ? { target } : {}) });
}

function outerPrefixes(paths: Set<string>): string[] {
  if (paths.has("")) return [""];
  return [...paths].filter(path => {
    const parts = path.split("/"); let ancestor = "";
    for (const part of parts.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${part}` : part;
      if (paths.has(ancestor)) return false;
    }
    return true;
  });
}

class MetadataIndex {
  readonly entries = new Map<string, NativeJournalMetadata>();
  readonly children = new Map<string, Set<string>>();
  readonly inodes = new Map<string, Set<string>>();
  readonly ignoreInputs = new Map<string, NativeJournalMetadata>();
  readonly steeringInputs = new Map<string, NativeJournalMetadata>();
  remove(path: string): void {
    const entry = this.entries.get(path); if (!entry) return;
    this.entries.delete(path); this.ignoreInputs.delete(path); this.steeringInputs.delete(path);
    const directory = parent(path), children = this.children.get(directory); children?.delete(path);
    if (!children?.size) this.children.delete(directory);
    const names = this.inodes.get(entry.inode); names?.delete(path);
    if (!names?.size) this.inodes.delete(entry.inode);
  }
  put(entry: NativeJournalMetadata): void {
    this.remove(entry.path); this.entries.set(entry.path, entry);
    if (entry.path.split("/").at(-1) === ".gitignore") this.ignoreInputs.set(entry.path, entry);
    if (isJournalSteeringPath(entry.path)) this.steeringInputs.set(entry.path, entry);
    const directory = parent(entry.path), children = this.children.get(directory) ?? new Set<string>();
    children.add(entry.path); this.children.set(directory, children);
    const names = this.inodes.get(entry.inode) ?? new Set<string>();
    names.add(entry.path); this.inodes.set(entry.inode, names);
  }
  *descendants(path: string): Generator<string> {
    for (const child of this.children.get(path) ?? []) {
      yield child;
      if (this.entries.get(child)?.kind === "directory") yield* this.descendants(child);
    }
  }
}

/** Descriptors and metadata only; even a regular file is never opened/read. */
class RootMetadataReader {
  readonly unreadable = new Map<string, NativeJournalUnreadable>();
  private constructor(private readonly root: FileHandle | undefined, private readonly signal: AbortSignal,
    private readonly checkpointId: string, private readonly manager: NativeJournalManager, private readonly workerUid?: () => number | undefined,
    private readonly known: (path: string) => NativeJournalMetadata | undefined = () => undefined,
    readonly stats = { readEntries: 0, walkedDirectories: 0 }) {}
  static async create(root: NativeJournalCheckpoint, signal: AbortSignal, manager: NativeJournalManager, workerUid?: () => number | undefined,
    known?: (path: string) => NativeJournalMetadata | undefined) {
    signal.throwIfAborted();
    if (root.readOnly !== true) unavailable("Native metadata requires a sealed checkpoint.");
    let descriptor: FileHandle;
    try { descriptor = await open(root.path, DIRECTORY); }
    catch (error) {
      if (!nativeJournalPermissionDenied(error) || workerUid?.() === undefined) throw error;
      return new RootMetadataReader(undefined, signal, root.id, manager, workerUid, known);
    }
    try { signal.throwIfAborted(); return new RootMetadataReader(descriptor, signal, root.id, manager, workerUid, known); }
    catch (error) { await descriptor.close(); throw error; }
  }
  private markUnreadable(path: string, known = this.known(path), ms = 0): undefined {
    this.unreadable.set(path || ".", { path: path || ".", bytes: known?.bytes ?? null, ...(known ? { mode: known.mode, kind: known.kind } : {}), reason: "worker_reader_unavailable", ms });
    return undefined;
  }
  private async privateStat(path: string, uid: number): Promise<NativeJournalMetadata | null | undefined> {
    if (!this.manager.statCheckpoint) throw new NativeJournalObservationError("Private checkpoint metadata requires the qualified fixed worker-UID reader.");
    this.stats.readEntries++;
    const started = performance.now();
    try { return await this.manager.statCheckpoint(this.checkpointId, path, uid, this.signal); }
    catch (error) { if (nativeJournalPermissionDenied(error)) return this.markUnreadable(path, this.known(path), Math.max(0, Math.round(performance.now() - started))); throw error; }
  }
  private async child(parentFd: number, name: string, path: string): Promise<NativeJournalMetadata> {
    this.signal.throwIfAborted(); this.stats.readEntries++;
    const info = await lstat(at(parentFd, name), { bigint: true });
    if (info.isDirectory() && path.split("/").length > 256) unavailable("Native metadata directory depth exceeds the supported bound.");
    const target = info.isSymbolicLink() ? rawText(await readlink(at(parentFd, name), { encoding: "buffer" })) : undefined;
    this.signal.throwIfAborted(); return metadata(path, info, target);
  }
  async get(path: string): Promise<NativeJournalMetadata | null | undefined> {
    const parts = path.split("/");
    if (!path || parts.some(part => !part || part === "." || part === ".." || part.includes("\0"))) unavailable("Invalid native metadata path.");
    if (parts.length > 257) unavailable("Native metadata directory depth exceeds the supported bound.");
    if (!this.root) {
      const uid = this.workerUid?.();
      if (uid === undefined || !this.manager.statCheckpoint) throw new NativeJournalObservationError("Private checkpoint metadata requires the qualified fixed worker-UID reader.");
      return this.privateStat(path, uid);
    }
    const chain: FileHandle[] = [];
    let fd = this.root.fd;
    try {
      for (const name of parts.slice(0, -1)) {
        this.signal.throwIfAborted(); const child = await open(at(fd, name), DIRECTORY);
        chain.push(child); fd = child.fd;
      }
      return await this.child(fd, parts.at(-1)!, path);
    } catch (error) {
      if (missing(error)) return null;
      const uid = nativeJournalPermissionDenied(error) ? this.workerUid?.() : undefined;
      if (uid === undefined) throw error;
      if (!this.manager.statCheckpoint) unavailable("Private checkpoint metadata requires the fixed worker-UID reader.");
      return this.privateStat(path, uid);
    }
    finally { for (const child of chain.reverse()) await child.close(); }
  }
  async *walk(path = ""): AsyncGenerator<NativeJournalMetadata> {
    const parts = path ? path.split("/") : [], chain: FileHandle[] = [];
    if (!this.root) {
      const uid = this.workerUid?.();
      if (uid === undefined) throw new NativeJournalObservationError("Private checkpoint inventory requires a qualified worker identity.");
      yield* this.walkPrivate(path, parts.length, uid); return;
    }
    let fd = this.root.fd;
    try {
      try {
        for (const name of parts) { this.signal.throwIfAborted(); const child = await open(at(fd, name), DIRECTORY); chain.push(child); fd = child.fd; }
      } catch (error) {
        const uid = nativeJournalPermissionDenied(error) ? this.workerUid?.() : undefined;
        if (uid === undefined) throw error;
        yield* this.walkPrivate(path, parts.length, uid); return;
      }
      yield* this.walkDirectory(fd, path, parts.length);
    } finally { for (const child of chain.reverse()) await child.close(); }
  }
  private async *walkDirectory(fd: number, path: string, depth: number): AsyncGenerator<NativeJournalMetadata> {
    this.signal.throwIfAborted();
    if (depth > 256) unavailable("Native metadata directory depth exceeds the supported bound.");
    this.stats.walkedDirectories++;
    let names: Buffer[];
    try { names = await readdir(at(fd, "."), { encoding: "buffer" }); }
    catch (error) {
      const uid = nativeJournalPermissionDenied(error) ? this.workerUid?.() : undefined;
      if (uid === undefined) throw error;
      yield* this.walkPrivate(path, depth, uid, false); return;
    }
    for (const bytes of names.sort(Buffer.compare)) {
      const name = rawText(bytes);
      if (!name || name.includes("/") || name.includes("\0") || name === "." || name === "..") unavailable("Invalid native directory entry.");
      const rel = path ? `${path}/${name}` : name;
      let entry: NativeJournalMetadata;
      try { entry = await this.child(fd, name, rel); }
      catch (error) {
        const uid = nativeJournalPermissionDenied(error) ? this.workerUid?.() : undefined;
        if (uid === undefined) throw error;
        yield* this.walkPrivate(path, depth, uid, false); return;
      }
      yield entry;
      if (entry.kind === "directory") {
        let child: FileHandle;
        try { child = await open(at(fd, name), DIRECTORY); }
        catch (error) {
          const uid = nativeJournalPermissionDenied(error) ? this.workerUid?.() : undefined;
          if (uid === undefined) throw error;
          yield* this.walkPrivate(rel, depth + 1, uid, true, entry); continue;
        }
        try { yield* this.walkDirectory(child.fd, rel, depth + 1); } finally { await child.close(); }
      }
    }
  }
  private async *walkPrivate(path: string, depth: number, uid: number, count = true, known = this.known(path)): AsyncGenerator<NativeJournalMetadata> {
    this.signal.throwIfAborted();
    if (depth > 256) unavailable("Native metadata directory depth exceeds the supported bound.");
    if (!this.manager.listCheckpoint) throw new NativeJournalObservationError("Private checkpoint inventory requires the fixed worker-UID reader.");
    if (count) this.stats.walkedDirectories++;
    let entries: NativeJournalMetadata[];
    const started = performance.now();
    try { entries = await this.manager.listCheckpoint(this.checkpointId, path, uid, this.signal); }
    catch (error) { if (nativeJournalPermissionDenied(error)) { this.markUnreadable(path, known, Math.max(0, Math.round(performance.now() - started))); return; } throw error; }
    for (const entry of entries) {
      this.signal.throwIfAborted(); this.stats.readEntries++;
      yield entry;
      if (entry.kind === "directory") yield* this.walkPrivate(entry.path, depth + 1, uid, true, entry);
    }
  }
  close(): Promise<void> { return this.root?.close() ?? Promise.resolve(); }
}

export interface NativeJournalObservation {
  beforeRoot: NativeJournalCheckpoint; afterRoot: NativeJournalCheckpoint;
  changes: NativeJournalChange[];
  stats: { readEntries: number; walkedDirectories: number };
  unreadable: NativeJournalUnreadable[];
  /** Invoke only after the caller's raw versions/change refs are durable. */
  commit(): Promise<void>;
  /** Retains the previous rolling root/index; release failure stays retryable. */
  abort(): Promise<void>;
}

/** Caller serializes membership and keeps startup consumers independently leased. */
export function createNativeJournalObserver(native: NativeJournalManager, workerUid?: () => number | undefined) {
  let index = new MetadataIndex(), root: NativeJournalCheckpoint | undefined;
  let missingInventory = new Map<string, NativeJournalUnreadable>();
  const uncertain = (path: string) => {
    for (const prefix of missingInventory.keys()) if (prefix === "." || prefix === path || path.startsWith(prefix + "/")) return true;
    return false;
  };
  function* visible(entries: IterableIterator<NativeJournalMetadata>): IterableIterator<NativeJournalMetadata> {
    for (const entry of entries) if (!uncertain(entry.path)) yield entry;
  }
  let initializing: Promise<void> | undefined, inFlight: Promise<NativeJournalObservation> | undefined;
  let pending: NativeJournalObservation | undefined, closed = false;
  const shutdown = new AbortController(), retained = new Set<string>();
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
  async function checkpoint(signal: AbortSignal) {
    const id = randomUUID(); retained.add(id);
    try {
      const answer = await native.checkpoint(id, signal);
      if (answer.id !== id) unavailable("Native checkpoint identity does not match its request.");
      signal.throwIfAborted(); return answer;
    } catch (error) { await release(id).catch(() => {}); throw error; }
  }
  async function release(checkpoint: NativeJournalCheckpoint | string) {
    const id = typeof checkpoint === "string" ? checkpoint : checkpoint.id;
    await native.release(id); retained.delete(id);
  }
  async function initialize(signal?: AbortSignal): Promise<void> {
    if (closed) unavailable("Native observer is closed.");
    if (root) return;
    if (initializing) return initializing;
    const active = signalFor(signal);
    initializing = (async () => {
      let captured: NativeJournalCheckpoint | undefined, reader: RootMetadataReader | undefined;
      try {
        captured = await checkpoint(active); reader = await RootMetadataReader.create(captured, active, native, workerUid);
        const initial = new MetadataIndex();
        for await (const entry of reader.walk()) initial.put(entry);
        active.throwIfAborted(); index = initial; root = captured; missingInventory = new Map(reader.unreadable);
      } catch (error) { if (captured) await release(captured).catch(() => {}); throw error; }
      finally { await reader?.close(); initializing = undefined; }
    })();
    return initializing;
  }
  async function prepare(signal?: AbortSignal): Promise<NativeJournalObservation> {
    await initialize(signal);
    const active = signalFor(signal), before = root!;
    let after: NativeJournalCheckpoint | undefined, reader: RootMetadataReader | undefined;
    try {
      after = await checkpoint(active);
      const job = await native.delta(before.id, after.id, active);
      // Observe an early transport failure without an unhandled rejection.
      void job.completed.catch(() => {});
      const paths = new Set<string>(), prefixes = new Set<string>();
      try {
        for await (const candidate of parseNativeBrainDelta(job.stream, {
          before: { uuid: before.uuid, transaction: BigInt(before.transaction) },
          after: { uuid: after.uuid, transaction: BigInt(after.transaction) }, signal: active,
        })) {
          for (const path of candidate.paths) paths.add(path);
          if (candidate.rename) { prefixes.add(candidate.rename.from); prefixes.add(candidate.rename.to); }
        }
        const outcome = await job.completed;
        if (outcome.exitCode !== 0) unavailable("Native delta helper did not exit successfully.");
      } catch (error) {
        // Parser abort returns the stream iterator; wait for owner reconciliation
        // before releasing roots the send process could still be reading.
        await job.completed.catch(() => {}); throw error;
      }
      const patches = new Map<string, NativeJournalMetadata | null | undefined>();
      reader = await RootMetadataReader.create(after, active, native, workerUid,
        path => patches.has(path) ? patches.get(path) ?? undefined : index.entries.get(path));
      const read = async (path: string) => {
        if (!patches.has(path)) patches.set(path, await reader!.get(path));
        return patches.get(path)!;
      };
      const oldDirectories = new Set<string>(), newDirectories = new Set<string>();
      // A newly created directory may be unreadable even though its name and
      // mode are stat-able. Inventory that changed prefix explicitly; a failed
      // child lookup alone cannot establish an empty directory or a deletion.
      for (const path of paths) {
        const parts = path.split("/");
        if (parts.length > 257) unavailable("Native metadata directory depth exceeds the supported bound.");
        for (let length = 1; length <= parts.length; length++) {
          const prefix = parts.slice(0, length).join("/");
          if (index.entries.get(prefix)?.kind === "directory") continue;
          const current = await read(prefix);
          if (current?.kind === "directory") { newDirectories.add(prefix); paths.add(prefix); }
        }
      }
      for (const missing of missingInventory.keys()) {
        if (missing === ".") { newDirectories.add(""); oldDirectories.add(""); continue; }
        const current = await read(missing);
        if (current?.kind === "directory") { newDirectories.add(missing); oldDirectories.add(missing); paths.add(missing); }
        else if (current === null && index.entries.get(missing)?.kind === "directory") { oldDirectories.add(missing); paths.add(missing); }
      }
      for (const prefix of prefixes) {
        if (index.entries.get(prefix)?.kind === "directory") oldDirectories.add(prefix);
        if ((await read(prefix))?.kind === "directory") newDirectories.add(prefix);
      }
      for (const prefix of outerPrefixes(oldDirectories)) for (const path of index.descendants(prefix)) paths.add(path);
      for (const prefix of outerPrefixes(newDirectories)) {
        for await (const entry of reader.walk(prefix)) { paths.add(entry.path); patches.set(entry.path, entry); }
      }
      // Old aliases plus new candidates cover content emitted via one hardlink.
      // Namespace operations separately supply newly created/moved alias paths.
      for (const path of paths) {
        const previous = index.entries.get(path), current = await read(path);
        for (const entry of [previous, current]) if (entry?.kind === "file") {
          for (const alias of index.inodes.get(entry.inode) ?? []) paths.add(alias);
        }
      }
      active.throwIfAborted();
      const changes: NativeJournalChange[] = [];
      for (const path of paths) {
        const previous = index.entries.get(path) ?? null, current = patches.get(path);
        if (current === undefined) continue; // Unknown is not proof of deletion.
        if (previous || current) changes.push({ path, before: previous, after: current });
      }
      const next = after;
      let state: "pending" | "committed" | "aborted" = "pending";
      const observation: NativeJournalObservation = {
        beforeRoot: before, afterRoot: next, changes, stats: { ...reader.stats }, unreadable: [...reader.unreadable.values()],
        async commit() {
          if (state === "aborted") unavailable("Native observation was already aborted.");
          if (state === "pending") {
            for (const [path, entry] of patches) { if (entry) index.put(entry); else if (entry === null) index.remove(path); }
            missingInventory = new Map(reader!.unreadable);
            root = next; state = "committed"; pending = undefined;
          }
          if (retained.has(before.id)) await release(before);
        },
        async abort() {
          if (state === "committed") unavailable("Native observation was already committed.");
          state = "aborted"; pending = undefined;
          if (retained.has(next.id)) await release(next);
        },
      };
      pending = observation; return observation;
    } catch (error) { if (after) await release(after).catch(() => {}); throw error; }
    finally { await reader?.close(); }
  }
  return {
    initialize,
    /** Borrowed until the next committed observation; never an independent lease. */
    currentRoot(): NativeJournalCheckpoint { if (closed || !root) return unavailable("Native observer is not initialized or is closed."); return root; },
    entries(): IterableIterator<NativeJournalMetadata> { if (closed) return unavailable("Native observer is closed."); return visible(index.entries.values()); },
    steeringEntries(): IterableIterator<NativeJournalMetadata> { if (closed) return unavailable("Native observer is closed."); return visible(index.steeringInputs.values()); },
    ignoreEntries(): IterableIterator<NativeJournalMetadata> { if (closed) return unavailable("Native observer is closed."); return visible(index.ignoreInputs.values()); },
    unreadableEntries(): NativeJournalUnreadable[] { return [...missingInventory.values()]; },
    get(path: string): NativeJournalMetadata | undefined { if (closed) return unavailable("Native observer is closed."); return uncertain(path) ? undefined : index.entries.get(path); },
    async observe(signal?: AbortSignal): Promise<NativeJournalObservation> {
      if (closed || inFlight || pending) unavailable("Native observation must be serialized and reconciled.");
      const operation = prepare(signal); inFlight = operation;
      try { return await operation; } finally { inFlight = undefined; }
    },
    async close() {
      closed = true; shutdown.abort(new Error("native_observer_closed"));
      await initializing?.catch(() => {}); await inFlight?.catch(() => {});
      if (pending) await pending.abort().catch(() => {});
      for (const id of retained) await release(id);
      root = undefined; index = new MetadataIndex(); missingInventory.clear();
    },
  };
}

export type NativeJournalObserver = ReturnType<typeof createNativeJournalObserver>;
