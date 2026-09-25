/**
 * The two committed sidecar caches, and the pruning that keeps them honest.
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
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";

// Committed sidecar cache of LLM-generated chunk contexts, keyed by content
// hash. brain.db is gitignored, so without this a fresh clone (or db loss)
// would re-generate every context through the LLM. Appended from the DB after
// every --embeddings run; consulted before generating.
function contextCachePath(root: string): string {
  return resolve(root, ".context-cache.jsonl");
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
function readSidecar(path: string): Sidecar {
  const sidecar: Sidecar = { entries: new Map(), other: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return sidecar; // no cache yet
  }
  const lines = raw.split("\n").filter((l) => l.trim());
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

function loadSidecar(path: string): Map<string, string> {
  const cache = new Map<string, string>();
  for (const [k, { v }] of readSidecar(path).entries) cache.set(k, v);
  return cache;
}

/**
 * Add the entries the file lacks, and keep every value it already has.
 *
 * Writes only when a key was added, so a run with nothing new leaves the file
 * byte-identical and git sees no change. A write also collapses a duplicated
 * key to its winning line.
 */
function appendSidecar(path: string, fresh: Array<{ k: string; v: string }>): void {
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
  writeFileSync(path, out.join("\n") + "\n", "utf-8");
}

export function loadContextCache(root: string): Map<string, string> {
  return loadSidecar(contextCachePath(root));
}

// Sidecar cache for vision-model asset descriptions, same rationale as the
// chunk-context cache: descriptions live only in the gitignored brain.db, so
// a fresh clone would re-describe every asset through the vision model.
function assetCachePath(root: string): string {
  return resolve(root, ".asset-cache.jsonl");
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
  return loadSidecar(assetCachePath(root));
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
    assetCachePath(root),
    rows.map((r) => ({ k: assetCacheKey(r.content_hash, r.title), v: r.content }))
  );
}

/**
 * Remove every line whose key `drop` selects, and return how many went.
 * Writes only when a line was removed.
 */
function removeSidecarLines(path: string, drop: (key: string) => boolean): number {
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
  writeFileSync(path, kept.length ? kept.join("\n") + "\n" : "", "utf-8");
  return lines.length - kept.length;
}

/** Remove the chunk contexts stored under `keys`; returns the lines removed. */
export function forgetContextEntries(root: string, keys: ReadonlySet<string>): number {
  return removeSidecarLines(contextCachePath(root), (k) => keys.has(k));
}

/** Remove every description of these bytes, under any title; returns the lines removed. */
export function forgetAssetEntries(root: string, contentHash: string): number {
  return removeSidecarLines(assetCachePath(root), (k) => assetKeyHash(k) === contentHash);
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
    removed.assets = removeSidecarLines(assetCachePath(root), (k) => !liveHashes.has(assetKeyHash(k)));

    const chunkRows = db
      .prepare(
        `SELECT c.heading, c.content, d.title
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.asset_type = 'markdown'`
      )
      .all() as { heading: string; content: string; title: string }[];
    const liveContexts = new Set(chunkRows.map((r) => chunkContextKey(r.title, r.heading, r.content)));
    removed.contexts = removeSidecarLines(contextCachePath(root), (k) => !liveContexts.has(k));
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
    contextCachePath(root),
    rows.map((r) => ({ k: chunkContextKey(r.title, r.heading, r.content), v: r.context }))
  );
}

