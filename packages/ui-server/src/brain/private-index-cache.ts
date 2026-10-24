/**
 * Reusing a provider-restricted turn's private index across turns (#2833,
 * option C).
 *
 * A clean masked build costs tens of seconds on a large brain, so the server
 * keeps one host-owned copy of it, the base, bound to the exact native
 * checkpoint it was built from and to the exact brain, policy, masks,
 * recipient and build command. The next turn proves its own final startup
 * view against that checkpoint through the native send delta, which the
 * kernel derives from both sealed roots, and classifies every changed path:
 *
 * - nothing the masked build reads changed (only the masked folders, the
 *   index directory, `.git` or top-level hidden directories, which it never
 *   sees): the turn gets a copy of the base;
 * - only new Markdown or asset files appeared outside the masks: the turn's
 *   copy is updated in place by the brain's own incremental `brain index`,
 *   which must report nothing updated or deleted, and becomes the next base;
 * - anything else, or a delta that cannot be read in full: a clean build,
 *   exactly as before this cache.
 *
 * Only additions are ever applied to a base, because a removed or rewritten
 * row leaves its bytes in SQLite free pages, FTS5 segments and the WAL. A
 * document moving into a masked folder, or any text that leaves the masked
 * view, therefore always takes a clean build: nothing that was once in the
 * base and is no longer visible can survive in an index a turn reads.
 *
 * The base lives in a directory only the server can enter, and each turn
 * gets its own writable copy, so a worker cannot change it. The kernel's
 * change stamps of its files are recorded when it is sealed and checked
 * around every copy; a base that changed anyway is discarded. Losing the
 * cache (eviction, idle expiry, restart) only costs the next clean build:
 * nothing here is authoritative, and `brain.db` stays disposable.
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedWorkerStartupView, nativeWorkerStartupInput, parseNativeBrainDelta, retainWorkerStartupView, workerIdentityHelper,
  type NativeBrainDeltaCandidate, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";

/** Distinct reusable bases kept at once; each holds one index copy and one retained checkpoint. */
export const PRIVATE_INDEX_CACHE_ENTRIES = 2;
/** A base unused this long is dropped, releasing the checkpoint it pins. */
export const PRIVATE_INDEX_CACHE_IDLE_MS = 30 * 60_000;
/** Changes to what the masked build produces from the same inputs bump this. */
const BUILD_SEMANTICS = "brain-index-masked-v1";
const BASE_PREFIX = "brain-private-index-base-";
/** The asset extensions core's index scans (`ASSET_EXTENSIONS`), matched in any case. */
const ASSET_EXTENSIONS = [".jpg", ".jpeg", ".png", ".pdf"];

/** Everything the masked build's output depends on besides the view's content. */
export interface PrivateIndexIdentity {
  /** The brain's canonical path. */
  brain: string;
  /** The effective policy's hash; null for the built-in default. */
  policyHash: string | null;
  /** The folders masked from this turn's recipient. */
  folders: readonly string[];
  /** The proven recipient, or none. */
  recipient?: string;
  maskPaths: readonly string[];
  /** The build's argv. */
  command: readonly string[];
}

export function privateIndexCacheKey(identity: PrivateIndexIdentity): string {
  return createHash("sha256").update(JSON.stringify([BUILD_SEMANTICS, identity.brain, identity.policyHash,
    [...identity.folders].sort(), identity.recipient ?? null, [...identity.maskPaths].sort(), [...identity.command]])).digest("hex");
}

/** The changed-path candidates between two sealed views, or undefined when they cannot be compared. */
export type PrivateIndexDiffer = (from: WorkerStartupView, to: WorkerStartupView, signal: AbortSignal) =>
  Promise<{ candidates: AsyncIterable<NativeBrainDeltaCandidate>; completed: Promise<unknown> } | undefined>;

/** The native send delta between two manager-acquired checkpoints. */
export const nativePrivateIndexDiffer: PrivateIndexDiffer = async (from, to, signal) => {
  if (!isManagedWorkerStartupView(from) || !isManagedWorkerStartupView(to)) return undefined;
  const before = nativeWorkerStartupInput(from), after = nativeWorkerStartupInput(to);
  if (before.manager !== after.manager || before.checkpoint.sourceUuid !== after.checkpoint.sourceUuid) return undefined;
  const job = await after.manager.delta(before.checkpoint.id, after.checkpoint.id, signal);
  // Observe an early transport failure without an unhandled rejection.
  void job.completed.catch(() => {});
  return { completed: job.completed, candidates: parseNativeBrainDelta(job.stream, { signal,
    before: { uuid: before.checkpoint.uuid, transaction: BigInt(before.checkpoint.transaction) },
    after: { uuid: after.checkpoint.uuid, transaction: BigInt(after.checkpoint.transaction) } }) };
};

export type PrivateIndexChanges = { kind: "unchanged" } | { kind: "additions"; paths: string[] } | { kind: "rebuild"; reason: string };

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The folders a masked build of the view at `root` sees as empty: the turn's
 * provider masks and every top-level hidden directory but `.git` (always
 * hidden) and the index directory, outermost only. The index never reads a
 * hidden directory (its scans skip hidden names), so hiding them changes no
 * clean build, and changes under them, such as `.brain/scratch`, cannot reach
 * one.
 */
export function privateIndexBuildFolders(masked: readonly string[], root: string): string[] {
  const hidden = readdirSync(root).filter(name => name.startsWith(".") && name !== ".git" && name !== INDEX_DIR
    && lstatSync(join(root, name)).isDirectory());
  return [...new Set([...masked.filter(folder => !hidden.some(top => within(folder, top))), ...hidden])].sort();
}

/**
 * Paths whose changes cannot change the masked build: the masked folders it
 * sees as empty, the index directory it replaces, `.git`, which it never
 * sees, and, given both roots, what is under a top-level hidden directory
 * that is a directory in both (`privateIndexBuildFolders`). Prefix-closed, so
 * a descendant of an inert path is inert.
 */
export function privateIndexInert(folders: readonly string[], roots?: { before: string; after: string }): (path: string) => boolean {
  const hidden = new Map<string, boolean>();
  const directoryInBoth = (top: string) => {
    let answer = hidden.get(top);
    if (answer === undefined) {
      answer = Boolean(roots) && [roots!.before, roots!.after].every(root => {
        try { return lstatSync(join(root, top)).isDirectory(); } catch { return false; }
      });
      hidden.set(top, answer);
    }
    return answer;
  };
  return path => within(path, ".git") || within(path, INDEX_DIR) || folders.some(folder => within(path, folder))
    || (path.startsWith(".") && directoryInBoth(path.split("/")[0]!));
}

/** A new file the incremental index adds without touching an existing row. */
function addable(path: string): boolean {
  const parts = path.split("/");
  if (parts.some(part => part.startsWith("."))) return false;
  const name = parts.at(-1)!, dot = name.lastIndexOf(".");
  return name.endsWith(".md") || (dot > 0 && ASSET_EXTENSIONS.includes(name.slice(dot).toLowerCase()));
}

class Unsafe extends Error {}
function stat(root: string, path: string): BigIntStats | null {
  try { return lstatSync(join(root, path), { bigint: true }); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw new Unsafe(`${path} cannot be inspected: ${(error as Error).message}`);
  }
}
function descendants(root: string, path: string, into: Set<string>, depth = 0): void {
  if (depth > 256) throw new Unsafe(`${path} is nested too deeply to inspect`);
  let names: string[];
  try { names = readdirSync(join(root, path)); } catch (error) { throw new Unsafe(`${path} cannot be listed: ${(error as Error).message}`); }
  for (const name of names) {
    const child = `${path}/${name}`;
    into.add(child);
    if (stat(root, child)?.isDirectory()) descendants(root, child, into, depth + 1);
  }
}

/**
 * Classify a complete delta between two sealed roots for the masked build.
 * A send stream names each changed inode by one path, so renamed directories
 * are expanded in both roots, and a file with a second name anywhere takes a
 * clean build rather than trusting the name the stream chose.
 */
export async function classifyPrivateIndexChanges(options: {
  before: string; after: string; candidates: AsyncIterable<NativeBrainDeltaCandidate>; inert: (path: string) => boolean;
}): Promise<PrivateIndexChanges> {
  const paths = new Set<string>(), endpoints = new Set<string>();
  for await (const candidate of options.candidates) {
    for (const path of candidate.paths) paths.add(path);
    if (candidate.rename) { endpoints.add(candidate.rename.from); endpoints.add(candidate.rename.to); }
  }
  try {
    // A directory renamed, created, removed or replaced: what is under it in
    // either root is a candidate too, unless it is inert.
    for (const path of [...paths]) {
      if (options.inert(path)) continue;
      const before = stat(options.before, path), after = stat(options.after, path);
      const expand = endpoints.has(path) || Boolean(before?.isDirectory()) !== Boolean(after?.isDirectory());
      if (!expand) continue;
      if (before?.isDirectory()) descendants(options.before, path, paths);
      if (after?.isDirectory()) descendants(options.after, path, paths);
    }
    const added: string[] = [];
    for (const path of [...paths].sort()) {
      const before = stat(options.before, path), after = stat(options.after, path);
      if (!before && !after) continue; // A send stream's temporary name.
      if ([before, after].some(entry => entry?.isFile() && entry.nlink > 1n)) return { kind: "rebuild", reason: `${path} has another name` };
      if (options.inert(path)) continue;
      if (before?.isDirectory() && after?.isDirectory()) continue; // Its own entries are candidates.
      if (!before && after?.isDirectory()) continue;
      if (!before && after?.isFile() && addable(path)) { added.push(path); continue; }
      return { kind: "rebuild", reason: !after ? `${path} was removed` : !before ? `${path} is not a document the index can add` : `${path} changed` };
    }
    return added.length ? { kind: "additions", paths: added } : { kind: "unchanged" };
  } catch (error) {
    if (error instanceof Unsafe) return { kind: "rebuild", reason: error.message };
    throw error;
  }
}

type Stamp = string;
const stampOf = (info: BigIntStats): Stamp => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.nlink}:${info.uid}`;

/** The regular files of a finished index directory; anything else is not a sealable index. */
function indexFiles(dir: string): string[] | undefined {
  const names = readdirSync(dir).sort();
  for (const name of names) if (!lstatSync(join(dir, name)).isFile()) return undefined;
  // SQLite rebuilds the shared-memory index from the WAL; it is no content.
  return names.filter(name => !name.endsWith("-shm"));
}

async function copyFiles(from: string, to: string, names: readonly string[], mode: number): Promise<void> {
  for (const name of names) {
    await Bun.write(join(to, name), Bun.file(join(from, name)));
    chmodSync(join(to, name), mode);
  }
}

interface Base { dir: string; stamps: Map<string, Stamp>; view: WorkerStartupView; key: string; used: number; timer?: ReturnType<typeof setTimeout> }

export type PrivateIndexOutcome =
  | { kind: "reused" } | { kind: "updated"; added: number }
  | { kind: "built"; reason: string } | { kind: "partial"; detail: string };

export interface PrivateIndexCache {
  /**
   * Fill `index` (an empty turn-private directory) with an index of the
   * masked `startupView`, reusing the base for `identity` when it provably
   * equals a clean build.
   */
  prepare(input: { identity: PrivateIndexIdentity; startupView: WorkerStartupView; index: string; signal: AbortSignal;
    /** A clean masked build into `index`. */
    build(): Promise<{ ok: true } | { ok: false; detail: string }>;
    /** The incremental `brain index --json` over `index`; its stdout. */
    update(): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>;
  }): Promise<PrivateIndexOutcome>;
  close(): Promise<void>;
}

export function createPrivateIndexCache(options: { differ?: PrivateIndexDiffer; report: (message: string) => void;
  entries?: number; idleMs?: number } = { report() {} }): PrivateIndexCache {
  const differ = options.differ ?? nativePrivateIndexDiffer;
  const limit = options.entries ?? PRIVATE_INDEX_CACHE_ENTRIES, idleMs = options.idleMs ?? PRIVATE_INDEX_CACHE_IDLE_MS;
  const bases = new Map<string, Base>(), chains = new Map<string, Promise<unknown>>();
  let closed = false;
  // The worker identity shares the server's primary group and writes the
  // turn's copy through it, as it writes a fresh private index.
  const turnMode = () => workerIdentityHelper() ? 0o660 : 0o600;

  async function drop(base: Base): Promise<void> {
    if (bases.get(base.key) === base) bases.delete(base.key);
    clearTimeout(base.timer);
    try { rmSync(base.dir, { recursive: true, force: true }); } finally { await base.view.cleanup(); }
  }
  const dropQuietly = (base: Base) => drop(base).catch(error => options.report(`private index cache release failed: ${String(error)}`));
  function touch(base: Base): void {
    base.used = Date.now();
    clearTimeout(base.timer);
    base.timer = setTimeout(() => { if (!chains.has(base.key)) void dropQuietly(base); }, idleMs);
    base.timer.unref?.();
  }
  function intact(base: Base): boolean {
    try {
      const names = readdirSync(base.dir).sort();
      if (names.length !== base.stamps.size) return false;
      return names.every(name => base.stamps.get(name) === stampOf(lstatSync(join(base.dir, name), { bigint: true })));
    } catch { return false; }
  }

  /** Copy a finished turn index into a new host-owned base bound to `view`. */
  async function seal(key: string, index: string, view: WorkerStartupView): Promise<void> {
    const names = indexFiles(index);
    if (!names) { options.report("private index cache: the build left something other than files; not reused"); return; }
    const dir = mkdtempSync(join(tmpdir(), `${BASE_PREFIX}${process.pid}-`));
    let retained: WorkerStartupView | undefined;
    try {
      chmodSync(dir, 0o700);
      await copyFiles(index, dir, names, 0o400);
      const stamps = new Map(names.map(name => [name, stampOf(lstatSync(join(dir, name), { bigint: true }))] as const));
      retained = retainWorkerStartupView(view);
      const base: Base = { dir, stamps, view: retained, key, used: Date.now() };
      const old = bases.get(key);
      bases.set(key, base); touch(base);
      if (old) await dropQuietly(old);
      // Least recently used first; a base another turn is reconciling stays.
      const idle = [...bases.values()].filter(other => other.key !== key && !chains.has(other.key)).sort((a, b) => a.used - b.used);
      for (const extra of idle.slice(0, Math.max(0, bases.size - limit))) await dropQuietly(extra);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      await retained?.cleanup();
      options.report(`private index cache: could not keep the build: ${String(error)}`);
    }
  }

  async function prepare(input: Parameters<PrivateIndexCache["prepare"]>[0]): Promise<PrivateIndexOutcome> {
    const key = privateIndexCacheKey(input.identity);
    const clean = async (reason: string): Promise<PrivateIndexOutcome> => {
      for (const name of readdirSync(input.index)) rmSync(join(input.index, name), { recursive: true, force: true });
      const built = await input.build();
      // A partial build is served but never kept; an older base stays bound to its own checkpoint.
      if (!built.ok) return { kind: "partial", detail: built.detail };
      if (!closed) await seal(key, input.index, input.startupView);
      return { kind: "built", reason };
    };
    const base = bases.get(key);
    if (!base) return clean(bases.size ? "no base for this policy, mask set and recipient" : "no base yet");
    if (!intact(base)) { await dropQuietly(base); return clean("the base changed outside the server"); }
    let changes: PrivateIndexChanges;
    try {
      const delta = await differ(base.view, input.startupView, input.signal);
      if (!delta) return clean("the views cannot be compared");
      const classified = classifyPrivateIndexChanges({ before: base.view.root, after: input.startupView.root, candidates: delta.candidates,
        inert: privateIndexInert(input.identity.folders, { before: base.view.root, after: input.startupView.root }) });
      // Both must finish: the parser proves END and EOF, the helper its exit.
      [changes] = await Promise.all([classified, delta.completed]);
    } catch (error) {
      input.signal.throwIfAborted();
      return clean(`the delta could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changes.kind === "rebuild") return clean(changes.reason);
    const names = [...base.stamps.keys()];
    await copyFiles(base.dir, input.index, names, turnMode());
    if (!intact(base)) { await dropQuietly(base); return clean("the base changed while it was copied"); }
    if (changes.kind === "unchanged") {
      // Identical for the masked build: bind the base to the newer checkpoint
      // so the old one is released and the next delta stays short.
      const retained = retainWorkerStartupView(input.startupView);
      const old = base.view; base.view = retained; touch(base);
      await old.cleanup();
      return { kind: "reused" };
    }
    const updated = await input.update();
    let stats: { updated?: unknown; deleted?: unknown; added?: unknown } | undefined;
    try { stats = updated.ok ? JSON.parse(updated.stdout) : undefined; } catch { stats = undefined; }
    if (!stats || stats.updated !== 0 || stats.deleted !== 0)
      return clean(updated.ok ? `the incremental index changed existing rows (${updated.stdout.trim().slice(0, 200)})` : `the incremental index failed: ${updated.detail}`);
    if (!closed) await seal(key, input.index, input.startupView);
    return { kind: "updated", added: Number(stats.added) || 0 };
  }

  return {
    async prepare(input) {
      if (closed) throw new Error("The private index cache is closed");
      const key = privateIndexCacheKey(input.identity);
      const previous = chains.get(key) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => { input.signal.throwIfAborted(); return prepare(input); });
      const settled = run.catch(() => {});
      chains.set(key, settled);
      try { return await run; } finally { if (chains.get(key) === settled) chains.delete(key); }
    },
    async close() {
      closed = true;
      await Promise.all([...chains.values()]);
      for (const base of [...bases.values()]) await dropQuietly(base);
    },
  };
}
