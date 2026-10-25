/**
 * The two committed sidecar caches, and the pruning that keeps them honest.
 *
 * They live in `.brain-cache/` (`CACHE_DIR`), not loose in the brain root, so
 * a provider-restricted worker can mask them as one retained directory
 * (#2725). A clone from before 0.44.0 keeps every line it committed at the
 * old root-level names: reads union both files, and the first write of a run
 * moves the old lines into the new file (`migrateSidecarCaches`).
 *
 * `brain.db` is gitignored, so without these a fresh clone would re-run every
 * LLM chunk-context and every vision asset description — the expensive,
 * billable parts of an index. Each embeddings run appends what the database
 * has and the file lacks, and generation consults them first, so they are
 * derived data in a tracked file: never hand-edited, union-merged on conflict.
 *
 * Appended, never rewritten. Two clones can generate different text for the
 * same key; if each wrote its own value back, every sync would flip the line
 * and commit it. Instead the committed value wins, and a key that appears
 * twice resolves to its first line in sorted order, so every clone reads the
 * same value from the same file.
 */
import type { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { basename, resolve } from "path";
import { ASSET_CACHE_PATH, CACHE_DIR, CONTEXT_CACHE_PATH, LEGACY_SIDECAR_CACHES } from "@schlessera/brain-common/internal/cache-location";

// Committed sidecar cache of LLM-generated chunk contexts, keyed by content
// hash. brain.db is gitignored, so without this a fresh clone (or db loss)
// would re-generate every context through the LLM. Appended from the DB after
// every --embeddings run; consulted before generating.
function contextCachePath(root: string): string {
  return resolve(root, CONTEXT_CACHE_PATH);
}

export function chunkContextKey(title: string, heading: string, content: string): string {
  return createHash("sha256")
    .update(`${title}\u0000${heading}\u0000${content}`)
    .digest("hex");
}

/** One sidecar file: each key's winning line and value, and every other line. */
interface Sidecar {
  entries: Map<string, { line: string; v: string }>;
  /** Lines that are not a `{k, v}` entry. Kept verbatim; not ours to discard. */
  other: string[];
}

/**
 * Read a sidecar, resolving a duplicated key to its first line in sorted
 * order. A union merge or a hand edit can leave two lines for one key, and
 * file order is not stable across clones; sorted order is.
 */
function readSidecar(...paths: string[]): Sidecar {
  const sidecar: Sidecar = { entries: new Map(), other: [] };
  const lines = paths.flatMap((path) => cacheLines(path));
  lines.sort();
  for (const line of lines) {
    let entry: { k?: unknown; v?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      sidecar.other.push(line);
      continue;
    }
    if (typeof entry?.k !== "string" || !entry.k || typeof entry.v !== "string") {
      sidecar.other.push(line);
    } else if (!sidecar.entries.has(entry.k)) {
      sidecar.entries.set(entry.k, { line, v: entry.v });
    }
  }
  return sidecar;
}

/** A cache file's non-blank lines; none when it does not exist. */
function cacheLines(path: string): string[] {
  try {
    return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return []; // no cache yet
  }
}

/** A cache file's non-blank lines, for a write: absence is none, and any other read failure throws. */
function strictCacheLines(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").filter((l) => l.trim());
}

/** The legacy root-level file whose lines belong in `path`'s cache. */
function legacyOf(root: string, path: string): string {
  const pair = LEGACY_SIDECAR_CACHES.find((p) => resolve(root, p.current) === path);
  return resolve(root, pair!.legacy);
}

/**
 * A cache's entries, read from its file and from a legacy root-level copy not
 * yet migrated, so a read never loses a line an older release committed.
 * Reading writes nothing: it works in a read-only brain.
 */
function loadSidecar(root: string, path: string): Map<string, string> {
  const cache = new Map<string, string>();
  for (const [k, { v }] of readSidecar(path, legacyOf(root, path)).entries) cache.set(k, v);
  return cache;
}

/** Whether a write failed only because this brain, or this worker's view of it, cannot be written. */
function unwritable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

/**
 * Move the caches a release before 0.44.0 kept at the brain root into
 * `.brain-cache/` (#2725), and return the legacy names moved.
 *
 * Every line of the old file is kept: the new file becomes the sorted union
 * of both files' distinct lines, so a key the two hold differently resolves
 * the way a union merge of them would (first line in sorted order), and no
 * paid enrichment is dropped. The new file is published whole, by rename,
 * before the old one is removed, so an interrupted move leaves both files
 * intact and the next one finishes it; the old file is removed only once
 * every line it holds is in the new one. Repeating it changes nothing. Only a
 * regular file is moved: a link, or the `/dev/null` a provider-restricted
 * worker sees in its place, is left alone. A file that cannot be read is
 * never removed, and a brain this process cannot write is left as it is;
 * reads still union both locations.
 */
export function migrateSidecarCaches(root: string): string[] {
  const moved: string[] = [];
  for (const { legacy, current } of LEGACY_SIDECAR_CACHES) {
    const from = resolve(root, legacy);
    if (!lstatSync(from, { throwIfNoEntry: false })?.isFile()) continue;
    try {
      requireCacheDir(root);
      const to = resolve(root, current);
      // A line appended to the old file meanwhile is moved on the next pass.
      for (let pass = 0; ; pass++) {
        const before = strictCacheLines(to);
        const lines = [...new Set([...before, ...strictCacheLines(from)])].sort();
        if (lines.length !== before.length || lines.some((line, i) => line !== before[i])) {
          writeCache(root, to, lines.length ? lines.join("\n") + "\n" : "");
        }
        const kept = new Set(lines);
        if (strictCacheLines(from).every((line) => kept.has(line))) break;
        if (pass === 2) throw new Error(`${legacy} kept changing while it was moved into ${CACHE_DIR}/`);
      }
      unlinkSync(from);
      moved.push(legacy);
    } catch (error) {
      if (unwritable(error)) continue;
      throw error;
    }
  }
  return moved;
}

/** Refuse a `.brain-cache` that is not a directory of its own: a link would send reads and writes into another tree. */
function requireCacheDir(root: string): void {
  const info = lstatSync(resolve(root, CACHE_DIR), { throwIfNoEntry: false });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${CACHE_DIR} in the brain root is not a directory`);
}

/**
 * Publish a cache file whole: written beside it in `.brain-cache/`, then
 * renamed over it, so a failed write never leaves a truncated cache. A rename
 * inside the directory detaches no mask laid over the directory.
 */
function writeCache(root: string, path: string, text: string): void {
  ensureCacheDir(root);
  const staged = resolve(root, CACHE_DIR, `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(staged, text, { encoding: "utf-8", flag: "wx" });
    // A replaced cache keeps its mode, as an in-place write would.
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing?.isFile()) chmodSync(staged, existing.mode & 0o7777);
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Create `.brain-cache/` when it is missing, with the brain root's permission
 * bits, as the index directory is: a hosted worker identity that can write
 * the root can write the caches. One under the name that is not a directory
 * of its own (a link, a file) is refused, never written through.
 */
function ensureCacheDir(root: string): void {
  const dir = resolve(root, CACHE_DIR);
  let info = lstatSync(dir, { throwIfNoEntry: false });
  if (!info) {
    try {
      mkdirSync(dir);
      chmodSync(dir, statSync(root).mode & 0o7777);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    info = lstatSync(dir);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${CACHE_DIR} in the brain root is not a directory`);
}

/**
 * Add the entries the file lacks, and keep every value it already has.
 *
 * Writes only when a key was added, so a run with nothing new leaves the file
 * byte-identical and git sees no change. A write also collapses a duplicated
 * key to its winning line.
 */
function appendSidecar(root: string, path: string, fresh: Array<{ k: string; v: string }>): void {
  migrateSidecarCaches(root);
  requireCacheDir(root);
  const sidecar = readSidecar(path);
  const added = new Map<string, string>();
  // Sorted, so two database rows with one key resolve the way a load would.
  const lines = fresh.map((e) => ({ k: e.k, line: JSON.stringify({ k: e.k, v: e.v }) }));
  lines.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  for (const { k, line } of lines) {
    if (!sidecar.entries.has(k) && !added.has(k)) added.set(k, line);
  }
  if (added.size === 0) return;
  const out = [...[...sidecar.entries.values()].map((e) => e.line), ...added.values(), ...sidecar.other];
  out.sort(); // stable ordering keeps git diffs minimal
  writeCache(root, path, out.join("\n") + "\n");
}

export function loadContextCache(root: string): Map<string, string> {
  return loadSidecar(root, contextCachePath(root));
}

// Sidecar cache for vision-model asset descriptions, same rationale as the
// chunk-context cache: descriptions live only in the gitignored brain.db, so
// a fresh clone would re-describe every asset through the vision model.
function assetCachePath(root: string): string {
  return resolve(root, ASSET_CACHE_PATH);
}

export function assetCacheKey(contentHash: string, title: string): string {
  return `${contentHash}:${title}`;
}

/** The content hash an asset key starts with. Hashes are hex, so the first colon ends it. */
function assetKeyHash(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}

export function loadAssetCache(root: string): Map<string, string> {
  return loadSidecar(root, assetCachePath(root));
}

/**
 * Look an asset's description up by its exact key, then by its bytes alone.
 *
 * The title is part of the key, so the same bytes under another name, or
 * under a title rule that changed, miss the exact key. Their description
 * still describes those bytes, and reusing it is free where the vision model
 * is not. Among several titles for one hash, the first in sorted order wins.
 */
export function assetDescriptionLookup(
  cache: Map<string, string>
): (contentHash: string, title: string) => string | undefined {
  let byHash: Map<string, string> | undefined;
  return (contentHash, title) => {
    const exact = cache.get(assetCacheKey(contentHash, title));
    if (exact !== undefined) return exact;
    if (!byHash) {
      byHash = new Map();
      for (const k of [...cache.keys()].sort()) {
        const hash = assetKeyHash(k);
        if (!byHash.has(hash)) byHash.set(hash, cache.get(k)!);
      }
    }
    return byHash.get(contentHash);
  };
}

export function saveAssetCache(db: Database, root: string): void {
  const rows = db
    .prepare(
      `SELECT content_hash, title, content
       FROM documents
       WHERE asset_type != 'markdown'
         AND content_hash IS NOT NULL
         AND content NOT LIKE '[Image:%' AND content NOT LIKE '[PDF:%'`
    )
    .all() as { content_hash: string; title: string; content: string }[];

  appendSidecar(
    root,
    assetCachePath(root),
    rows.map((r) => ({ k: assetCacheKey(r.content_hash, r.title), v: r.content }))
  );
}

/**
 * Remove every line whose key `drop` selects, and return how many went.
 * Writes only when a line was removed.
 */
function removeSidecarLines(root: string, path: string, drop: (key: string) => boolean): number {
  migrateSidecarCaches(root);
  requireCacheDir(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return 0; // no cache yet
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const kept = lines.filter((line) => {
    try {
      const entry = JSON.parse(line) as { k?: string };
      return !entry.k || !drop(entry.k);
    } catch {
      return true; // leave malformed lines alone; not ours to discard
    }
  });
  if (kept.length === lines.length) return 0;
  writeCache(root, path, kept.length ? kept.join("\n") + "\n" : "");
  return lines.length - kept.length;
}

/** Remove the chunk contexts stored under `keys`; returns the lines removed. */
export function forgetContextEntries(root: string, keys: ReadonlySet<string>): number {
  return removeSidecarLines(root, contextCachePath(root), (k) => keys.has(k));
}

/** Remove every description of these bytes, under any title; returns the lines removed. */
export function forgetAssetEntries(root: string, contentHash: string): number {
  return removeSidecarLines(root, assetCachePath(root), (k) => assetKeyHash(k) === contentHash);
}

/**
 * Drop sidecar entries nothing can reach any more.
 *
 * The caches are keyed by content — an asset by `${content_hash}:${title}`, a
 * chunk context by a hash of title/heading/body — so deleting a file does not
 * remove its entry, it just makes it unreachable. `saveAssetCache` and
 * `saveContextCache` only ever add, so nothing else removes it.
 *
 * Pruning by reachability is safe on any machine. It asks only whether a key
 * still corresponds to something in the index, which is true regardless of
 * whether this machine can generate descriptions. Left alone, the file grows
 * forever and a deletion is never quite a deletion — the description of a
 * removed image stays in a tracked file.
 *
 * An asset entry is reachable while any indexed asset has its bytes, whatever
 * the title. The title rules differ between versions and module sets, and a
 * clone that titles an asset differently must not delete a description that
 * `assetDescriptionLookup` can still reuse.
 *
 * Writes only when something was actually removed, so a no-op index run leaves
 * no git diff.
 */
export function pruneSidecarCaches(
  db: Database,
  root: string,
  warn: (message: string) => void
): { assets: number; contexts: number } {
  const removed = { assets: 0, contexts: 0 };

  try {
    const assetRows = db
      .prepare(
        `SELECT content_hash FROM documents
         WHERE asset_type != 'markdown' AND content_hash IS NOT NULL`
      )
      .all() as { content_hash: string }[];
    const liveHashes = new Set(assetRows.map((r) => r.content_hash));
    removed.assets = removeSidecarLines(root, assetCachePath(root), (k) => !liveHashes.has(assetKeyHash(k)));

    const chunkRows = db
      .prepare(
        `SELECT c.heading, c.content, d.title
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.asset_type = 'markdown'`
      )
      .all() as { heading: string; content: string; title: string }[];
    const liveContexts = new Set(chunkRows.map((r) => chunkContextKey(r.title, r.heading, r.content)));
    removed.contexts = removeSidecarLines(root, contextCachePath(root), (k) => !liveContexts.has(k));
  } catch (e) {
    warn(`  Could not prune sidecar caches: ${(e as Error).message}`);
  }

  return removed;
}

export function saveContextCache(db: Database, root: string): void {
  const rows = db
    .prepare(
      `SELECT c.heading, c.content, c.context, d.title
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.asset_type = 'markdown' AND c.context IS NOT NULL AND c.context != ''`
    )
    .all() as { heading: string; content: string; context: string; title: string }[];

  appendSidecar(
    root,
    contextCachePath(root),
    rows.map((r) => ({ k: chunkContextKey(r.title, r.heading, r.content), v: r.context }))
  );
}

