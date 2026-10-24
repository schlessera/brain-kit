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
 *   index directory, `.git` or the operational-state folders it never sees):
 *   the turn gets a copy of the base;
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
 * The base lives in a directory only the server can enter, under a parent
 * every worker sees as its own empty `/tmp` (or a masked operational-state
 * path); each turn gets its own writable copy. The kernel's change stamps of
 * its files are recorded when it is sealed and checked around every copy; a
 * base that changed anyway is discarded. Losing the cache (eviction, idle
 * expiry, restart) only costs the next clean build: nothing here is
 * authoritative, and `brain.db` stays disposable.
 */
import { createHash } from "node:crypto";
import { chmodSync, chownSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
/**
 * Operational state core and the server keep inside a brain: scratch,
 * scratch pins, inbox staging. Never configuration and never indexed (the
 * index's scans skip hidden names), so the masked build sees them as empty,
 * and what turns write there cannot reach any build.
 */
export const PRIVATE_INDEX_STATE_FOLDERS = [".brain", ".brain-ui"] as const;

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

/**
 * The identity of the runtime and of every absolute file the argv names. The
 * default command lives in the brain, where the delta covers it; a command
 * outside it is identified by its files' change stamps.
 */
function commandIdentity(command: readonly string[]): string[] {
  return [Bun.version, ...command.filter(part => isAbsolute(part)).map(part => {
    try { const info = statSync(part, { bigint: true }); return `${part}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
    catch { return `${part}:missing`; }
  })];
}

export function privateIndexCacheKey(identity: PrivateIndexIdentity): string {
  return createHash("sha256").update(JSON.stringify([BUILD_SEMANTICS, identity.brain, identity.policyHash,
    [...identity.folders].sort(), identity.recipient ?? null, [...identity.maskPaths].sort(), [...identity.command],
    commandIdentity(identity.command)])).digest("hex");
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

export type PrivateIndexChanges = { kind: "unchanged" } | { kind: "additions"; paths: string[] }
  /** `documents`: only Markdown or asset files changed, so the configuration and the masks it decides did not. */
  | { kind: "rebuild"; reason: string; documents?: true };

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The folders a masked build of the view at `root` sees as empty: the turn's
 * provider masks and the operational-state folders that are directories
 * there, outermost only.
 */
export function privateIndexBuildFolders(masked: readonly string[], root: string): string[] {
  const state = PRIVATE_INDEX_STATE_FOLDERS.filter(name => lstatSync(join(root, name), { throwIfNoEntry: false })?.isDirectory());
  return [...new Set([...masked.filter(folder => !state.some(top => within(folder, top))), ...state])].sort();
}

/**
 * Paths whose changes cannot change the masked build: the masked folders it
 * sees as empty, the index directory it replaces, `.git`, which it never
 * sees, and, given both roots, what is under an operational-state folder
 * that is a directory in both (`privateIndexBuildFolders`). Prefix-closed, so
 * a descendant of an inert path is inert.
 */
export function privateIndexInert(folders: readonly string[], roots?: { before: string; after: string }): (path: string) => boolean {
  const state = PRIVATE_INDEX_STATE_FOLDERS.filter(name => roots && [roots.before, roots.after].every(root => {
    try { return lstatSync(join(root, name)).isDirectory(); } catch { return false; }
  }));
  return path => within(path, ".git") || within(path, INDEX_DIR) || folders.some(folder => within(path, folder))
    || state.some(folder => path.startsWith(`${folder}/`));
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
    throw new Unsafe(`${path || "the brain root"} cannot be inspected: ${(error as Error).message}`);
  }
}
/** Who may read a directory: what decides which of its entries a build sees. */
const access = (info: BigIntStats) => `${info.mode}:${info.uid}:${info.gid}`;
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
 * clean build rather than trusting the name the stream chose. A directory in
 * both roots is unchanged only if who may read it is unchanged: its mode,
 * owner, group and extended attributes (ACLs).
 */
export async function classifyPrivateIndexChanges(options: {
  before: string; after: string; candidates: AsyncIterable<NativeBrainDeltaCandidate>; inert: (path: string) => boolean;
}): Promise<PrivateIndexChanges> {
  const paths = new Set<string>(), endpoints = new Set<string>(), attributes = new Set<string>();
  for await (const candidate of options.candidates) {
    for (const path of candidate.paths) paths.add(path);
    if (candidate.rename) { endpoints.add(candidate.rename.from); endpoints.add(candidate.rename.to); }
    if (candidate.xattr !== undefined) attributes.add(candidate.xattr);
  }
  try {
    // The root's own metadata carries no path in the stream.
    const rootBefore = stat(options.before, ""), rootAfter = stat(options.after, "");
    if (!rootBefore?.isDirectory() || !rootAfter?.isDirectory() || access(rootBefore) !== access(rootAfter) || attributes.has(""))
      return { kind: "rebuild", reason: "who may read the brain root changed" };
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
    let document: string | undefined;
    for (const path of [...paths].sort()) {
      const before = stat(options.before, path), after = stat(options.after, path);
      if (!before && !after) continue; // A send stream's temporary name.
      if ([before, after].some(entry => entry?.isFile() && entry.nlink > 1n)) return { kind: "rebuild", reason: `${path} has another name` };
      if (options.inert(path)) continue;
      if (before?.isDirectory() && after?.isDirectory()) {
        // Its own entries are candidates; a timestamp alone changes no build.
        if (access(before) !== access(after) || attributes.has(path)) return { kind: "rebuild", reason: `who may read ${path} changed` };
        continue;
      }
      // A new directory's entries are candidates, and the incremental index
      // reads them as the same worker a clean build would.
      if (!before && after?.isDirectory()) continue;
      if (!before && after?.isFile() && addable(path)) { added.push(path); continue; }
      const reason = !after ? `${path} was removed` : !before ? `${path} is not a document the index can add` : `${path} changed`;
      // A document changed or removed: only a clean build may drop its text.
      if ([before, after].every(entry => !entry || entry.isFile()) && addable(path)) { document ??= reason; continue; }
      return { kind: "rebuild", reason };
    }
    if (document) return { kind: "rebuild", reason: document, documents: true };
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

/**
 * Where bases may live: a directory no worker can see. Every worker gets its
 * own empty `/tmp`, and the operational-state mask paths are masked in every
 * worker; anywhere else (a `TMPDIR` on the host root that workers see read
 * only) keeps no base at all.
 */
function hiddenParent(maskPaths: readonly string[]): string | undefined {
  let parent: string;
  try { parent = realpathSync(tmpdir()); } catch { return undefined; }
  return [`/tmp`, ...maskPaths].some(masked => within(parent, masked)) ? parent : undefined;
}

/** Bases a crashed server left behind: its process is gone, so nothing else owns them. */
function sweepOrphans(parent: string): void {
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    const pid = Number(/^brain-private-index-base-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const dir = join(parent, name);
    try { if (lstatSync(dir).isDirectory() && lstatSync(dir).uid === process.geteuid!()) rmSync(dir, { recursive: true, force: true }); } catch { /* another sweep */ }
  }
}

/** Runs the masked build over another view into another directory; how a base advances off the turn path. */
export type PrivateIndexRunner = (view: WorkerStartupView, index: string, signal: AbortSignal) => {
  build(): Promise<{ ok: true } | { ok: false; detail: string }>;
  update(): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>;
};

interface Base { dir: string; stamps: Map<string, Stamp>; view: WorkerStartupView; key: string; used: number;
  folders: readonly string[]; runner?: PrivateIndexRunner; timer?: ReturnType<typeof setTimeout> }

/** What advancing one base did, for receipts and tests. */
export type PrivateIndexAdvance = { key: string; kind: "rebound" | "updated" | "rebuilt" | "dropped" | "kept"; reason?: string; ms: number };

export type PrivateIndexOutcome = (
  | { kind: "reused" } | { kind: "updated"; added: number }
  | { kind: "built"; reason: string } | { kind: "partial"; detail: string }
) & {
  /** Milliseconds per step (delta, copy, update, build, seal), for receipts. */
  readonly ms?: Readonly<Record<string, number>>;
};

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
    /** The same build over another view, kept with the base so it can advance off the turn path. */
    runner?: PrivateIndexRunner;
  }): Promise<PrivateIndexOutcome>;
  /**
   * Bring every base up to a fresh checkpoint of the live brain, off the
   * turn path (#2833, option B): after the post-turn index refresh, so the
   * next warm turn usually finds its base unchanged. Each base is reconciled
   * exactly as a turn would, in its key's chain; what cannot be proved drops
   * the base. Concurrent calls coalesce into one more pass.
   */
  advance(acquire: (signal: AbortSignal) => Promise<WorkerStartupView>): Promise<PrivateIndexAdvance[]>;
  close(): Promise<void>;
}

export function createPrivateIndexCache(options: { differ?: PrivateIndexDiffer; report: (message: string) => void;
  entries?: number; idleMs?: number; onAdvance?: (results: PrivateIndexAdvance[]) => void } = { report() {} }): PrivateIndexCache {
  const differ = options.differ ?? nativePrivateIndexDiffer;
  const limit = options.entries ?? PRIVATE_INDEX_CACHE_ENTRIES, idleMs = options.idleMs ?? PRIVATE_INDEX_CACHE_IDLE_MS;
  const bases = new Map<string, Base>(), chains = new Map<string, Promise<unknown>>();
  const swept = new Set<string>(), refused = new Set<string>();
  let closed = false;
  const shutdown = new AbortController();
  let advancing: Promise<PrivateIndexAdvance[]> | undefined, again = false;
  // The worker identity shares the server's primary group and writes the
  // turn's copy through it, as it writes a fresh private index.
  const turnMode = () => workerIdentityHelper() ? 0o660 : 0o600;

  /** Remove a base from the map at once, then release what it holds. */
  async function drop(base: Base): Promise<void> {
    if (bases.get(base.key) === base) bases.delete(base.key);
    clearTimeout(base.timer);
    try { rmSync(base.dir, { recursive: true, force: true }); } finally { await base.view.cleanup(); }
  }
  const dropQuietly = (base: Base) => drop(base).catch(error => options.report(`private index cache release failed: ${String(error)}`));
  /**
   * Drop expired bases, then the least recently used beyond the bound. A base
   * a turn is reconciling stays; each candidate is checked again just before
   * it is dropped, since releasing another one awaits. Runs whenever a turn
   * finishes and when a timer fires, so a skipped expiry is not lost.
   */
  async function trim(): Promise<void> {
    const idle = (base: Base) => bases.get(base.key) === base && !chains.has(base.key);
    for (const base of [...bases.values()]) if (idle(base) && (closed || Date.now() - base.used >= idleMs)) await dropQuietly(base);
    for (;;) {
      const candidates = [...bases.values()].filter(idle).sort((a, b) => a.used - b.used);
      if (bases.size <= limit || !candidates.length) return;
      await dropQuietly(candidates[0]!);
    }
  }
  /** Expire `base` `idleMs` after a turn last used it. */
  function schedule(base: Base): void {
    clearTimeout(base.timer);
    base.timer = setTimeout(() => void trim(), Math.max(0, base.used + idleMs - Date.now()) + 1);
    base.timer.unref?.();
  }
  /** A turn used `base`; an advance never does, so an unused base still expires. */
  function touch(base: Base): void { base.used = Date.now(); schedule(base); }
  function intact(base: Base): boolean {
    try {
      const names = readdirSync(base.dir).sort();
      if (names.length !== base.stamps.size) return false;
      return names.every(name => base.stamps.get(name) === stampOf(lstatSync(join(base.dir, name), { bigint: true })));
    } catch { return false; }
  }

  /** Replace the base for `key`, dropping the one it supersedes. */
  async function install(base: Base): Promise<void> {
    const old = bases.get(base.key);
    bases.set(base.key, base); schedule(base);
    if (old && old !== base) await dropQuietly(old);
  }

  /** Copy a finished turn index into a new host-owned base bound to `view`. */
  async function seal(key: string, index: string, view: WorkerStartupView, parent: string, folders: readonly string[], runner?: PrivateIndexRunner): Promise<void> {
    const names = indexFiles(index);
    if (!names) { options.report("private index cache: the build left something other than files; not reused"); return; }
    const dir = mkdtempSync(join(parent, `${BASE_PREFIX}${process.pid}-`));
    let retained: WorkerStartupView | undefined;
    try {
      chmodSync(dir, 0o700);
      await copyFiles(index, dir, names, 0o400);
      const stamps = new Map(names.map(name => [name, stampOf(lstatSync(join(dir, name), { bigint: true }))] as const));
      retained = retainWorkerStartupView(view);
      await install({ dir, stamps, view: retained, key, used: Date.now(), folders, ...(runner ? { runner } : {}) });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      await retained?.cleanup();
      options.report(`private index cache: could not keep the build: ${String(error)}`);
    }
  }

  async function prepare(input: Parameters<PrivateIndexCache["prepare"]>[0]): Promise<PrivateIndexOutcome> {
    const ms: Record<string, number> = {};
    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try { return await run(); } finally { ms[step] = Math.round((ms[step] ?? 0) + performance.now() - started); }
    };
    const outcome = await reconcile(input, timed);
    return { ...outcome, ms };
  }

  async function reconcile(input: Parameters<PrivateIndexCache["prepare"]>[0],
    timed: <T>(step: string, run: () => Promise<T>) => Promise<T>): Promise<PrivateIndexOutcome> {
    const key = privateIndexCacheKey(input.identity);
    const parent = hiddenParent(input.identity.maskPaths);
    if (parent && !swept.has(parent)) { swept.add(parent); sweepOrphans(parent); }
    if (!parent && !refused.has(tmpdir())) {
      refused.add(tmpdir());
      options.report(`private index cache disabled: ${tmpdir()} is visible to workers; every restricted turn builds its index from nothing`);
    }
    const clean = async (reason: string): Promise<PrivateIndexOutcome> => {
      for (const name of readdirSync(input.index)) rmSync(join(input.index, name), { recursive: true, force: true });
      const built = await timed("build", () => input.build());
      // A partial build is served but never kept; an older base stays bound to its own checkpoint.
      if (!built.ok) return { kind: "partial", detail: built.detail };
      if (!closed && parent) await timed("seal", () => seal(key, input.index, input.startupView, parent, input.identity.folders, input.runner));
      return { kind: "built", reason };
    };
    const base = bases.get(key);
    if (!parent || !base) return clean(!parent ? "no hidden place to keep a base" : bases.size ? "no base for this policy, mask set and recipient" : "no base yet");
    if (!intact(base)) { await dropQuietly(base); return clean("the base changed outside the server"); }
    let changes: PrivateIndexChanges;
    try {
      const delta = await differ(base.view, input.startupView, input.signal);
      if (!delta) return clean("the views cannot be compared");
      const classified = classifyPrivateIndexChanges({ before: base.view.root, after: input.startupView.root, candidates: delta.candidates,
        inert: privateIndexInert(input.identity.folders, { before: base.view.root, after: input.startupView.root }) });
      // Both must finish: the parser proves END and EOF, the helper its exit.
      [changes] = await timed("delta", () => Promise.all([classified, delta.completed]));
    } catch (error) {
      input.signal.throwIfAborted();
      return clean(`the delta could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changes.kind === "rebuild") return clean(changes.reason);
    const names = [...base.stamps.keys()];
    await timed("copy", () => copyFiles(base.dir, input.index, names, turnMode()));
    if (!intact(base)) { await dropQuietly(base); return clean("the base changed while it was copied"); }
    if (changes.kind === "unchanged") {
      // Identical for the masked build: bind the base to the newer checkpoint
      // so the old one is released and the next delta stays short.
      const retained = retainWorkerStartupView(input.startupView);
      const old = base.view; base.view = retained; touch(base);
      await old.cleanup();
      return { kind: "reused" };
    }
    const updated = await timed("update", () => input.update());
    let stats: { updated?: unknown; deleted?: unknown; added?: unknown } | undefined;
    try { stats = updated.ok ? JSON.parse(updated.stdout) : undefined; } catch { stats = undefined; }
    if (!stats || stats.updated !== 0 || stats.deleted !== 0)
      return clean(updated.ok ? `the incremental index changed existing rows (${updated.stdout.trim().slice(0, 200)})` : `the incremental index failed: ${updated.detail}`);
    if (!closed) await timed("seal", () => seal(key, input.index, input.startupView, parent, input.identity.folders, input.runner));
    return { kind: "updated", added: Number(stats.added) || 0 };
  }

  /** Run `work` after everything already queued for `key`; turns and advances alike. */
  async function serialize<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => { signal.throwIfAborted(); return work(); });
    const settled = run.catch(() => {});
    chains.set(key, settled);
    try { return await run; } finally { if (chains.get(key) === settled) chains.delete(key); await trim(); }
  }

  /** A worker-writable directory beside the bases, which can itself become one. */
  function staging(parent: string): string {
    const dir = mkdtempSync(join(parent, `${BASE_PREFIX}${process.pid}-`));
    try {
      if (workerIdentityHelper()) chownSync(dir, process.getuid!(), process.getgid!());
      chmodSync(dir, workerIdentityHelper() ? 0o2770 : 0o700);
    } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
    return dir;
  }

  /**
   * Make a finished staging directory the base for `key`, bound to `view`,
   * without another copy: only the server may enter it from now on (`0700`),
   * and its files' change stamps are recorded as a sealed copy's are.
   */
  async function promote(previous: Base, dir: string, view: WorkerStartupView): Promise<boolean> {
    for (const name of readdirSync(dir)) if (name.endsWith("-shm")) rmSync(join(dir, name), { force: true });
    const names = indexFiles(dir);
    if (!names) return false;
    chmodSync(dir, 0o700);
    const stamps = new Map(names.map(name => [name, stampOf(lstatSync(join(dir, name), { bigint: true }))] as const));
    await install({ dir, stamps, view: retainWorkerStartupView(view), key: previous.key, used: previous.used, folders: previous.folders,
      ...(previous.runner ? { runner: previous.runner } : {}) });
    return true;
  }

  /** Reconcile one base to `view`, exactly as a turn would, but never serving it. */
  async function advanceBase(key: string, view: WorkerStartupView): Promise<PrivateIndexAdvance> {
    const started = performance.now();
    const done = (kind: PrivateIndexAdvance["kind"], reason?: string): PrivateIndexAdvance =>
      ({ key, kind, ...(reason ? { reason } : {}), ms: Math.round(performance.now() - started) });
    const base = bases.get(key);
    if (!base) return done("kept", "no base");
    if (!base.runner) return done("kept", "no way to rebuild this base off the turn path");
    if (!intact(base)) { await dropQuietly(base); return done("dropped", "the base changed outside the server"); }
    let changes: PrivateIndexChanges;
    try {
      const delta = await differ(base.view, view, shutdown.signal);
      if (!delta) { await dropQuietly(base); return done("dropped", "the views cannot be compared"); }
      const classified = classifyPrivateIndexChanges({ before: base.view.root, after: view.root, candidates: delta.candidates,
        inert: privateIndexInert(base.folders, { before: base.view.root, after: view.root }) });
      [changes] = await Promise.all([classified, delta.completed]);
    } catch (error) {
      if (shutdown.signal.aborted) return done("kept", "closing");
      await dropQuietly(base); return done("dropped", `the delta could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changes.kind === "unchanged") {
      const old = base.view; base.view = retainWorkerStartupView(view);
      await old.cleanup();
      return done("rebound");
    }
    // A change beyond documents may move the masks themselves (the
    // configuration decides what a type selector hides): only a turn, which
    // translates them again, may build for it.
    if (changes.kind === "rebuild" && !changes.documents) { await dropQuietly(base); return done("dropped", changes.reason); }
    // Beside the base, whose parent was proved hidden from workers when it was kept.
    const dir = staging(dirname(base.dir));
    let promoted = false;
    try {
      const run = base.runner(view, dir, shutdown.signal);
      if (changes.kind === "additions") {
        await copyFiles(base.dir, dir, [...base.stamps.keys()], turnMode());
        if (!intact(base)) { await dropQuietly(base); return done("dropped", "the base changed while it was copied"); }
        const updated = await run.update();
        let stats: { updated?: unknown; deleted?: unknown } | undefined;
        try { stats = updated.ok ? JSON.parse(updated.stdout) : undefined; } catch { stats = undefined; }
        if (!stats || stats.updated !== 0 || stats.deleted !== 0) {
          // Unproved: the next turn reconciles from the base's own checkpoint.
          return done("kept", updated.ok ? "the incremental index changed existing rows" : `the incremental index failed: ${updated.detail}`);
        }
        promoted = !closed && await promote(base, dir, view);
        return promoted ? done("updated") : done("kept", "the update left something other than files");
      }
      const built = await run.build();
      if (!built.ok) return done("kept", `the clean build is incomplete: ${built.detail}`);
      promoted = !closed && await promote(base, dir, view);
      return promoted ? done("rebuilt", changes.reason) : done("kept", "the build left something other than files");
    } finally { if (!promoted) rmSync(dir, { recursive: true, force: true }); }
  }

  async function advanceOnce(acquire: (signal: AbortSignal) => Promise<WorkerStartupView>): Promise<PrivateIndexAdvance[]> {
    // Expired bases go first: an advance is no use, and never a renewal.
    await trim();
    const keys = [...bases.keys()];
    if (!keys.length || closed) return [];
    let view: WorkerStartupView;
    try { view = await acquire(shutdown.signal); }
    catch (error) { if (!closed) options.report(`private index advance could not take a checkpoint: ${String(error)}`); return []; }
    const results: PrivateIndexAdvance[] = [];
    try {
      for (const key of keys) {
        if (closed) break;
        try { results.push(await serialize(key, shutdown.signal, () => advanceBase(key, view))); }
        catch (error) { if (!closed) options.report(`private index advance failed: ${String(error)}`); }
      }
    } finally { await view.cleanup(); }
    return results;
  }

  return {
    async prepare(input) {
      if (closed) throw new Error("The private index cache is closed");
      return serialize(privateIndexCacheKey(input.identity), input.signal, () => prepare(input));
    },
    advance(acquire) {
      if (closed || !bases.size) return Promise.resolve([]);
      if (advancing) { again = true; return advancing; }
      advancing = (async () => {
        const all: PrivateIndexAdvance[] = [];
        do { again = false; all.push(...await advanceOnce(acquire)); } while (again && !closed);
        options.onAdvance?.(all);
        return all;
      })().finally(() => { advancing = undefined; });
      return advancing;
    },
    async close() {
      closed = true;
      shutdown.abort(new Error("private index cache closed"));
      await advancing?.catch(() => {});
      while (chains.size) await Promise.all([...chains.values()]);
      await trim();
    },
  };
}
