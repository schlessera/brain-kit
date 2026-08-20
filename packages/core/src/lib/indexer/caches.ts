/**
 * The two committed sidecar caches, and the pruning that keeps them honest.
 *
 * `brain.db` is gitignored, so without these a fresh clone would re-run every
 * LLM chunk-context and every vision asset description — the expensive,
 * billable parts of an index. They are rebuilt FROM the database after each
 * embeddings run and consulted before generating, so they are derived data in
 * a tracked file: never hand-edited, union-merged on conflict.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { resolve } from "path";

// Committed sidecar cache of LLM-generated chunk contexts, keyed by content
// hash. brain.db is gitignored, so without this a fresh clone (or db loss)
// would re-generate every context through the LLM. Rebuilt from the DB after
// every --embeddings run; consulted before generating.
function contextCachePath(root: string): string {
  return resolve(root, ".context-cache.jsonl");
}

export function chunkContextKey(title: string, heading: string, content: string): string {
  return createHash("sha256")
    .update(`${title}\u0000${heading}\u0000${content}`)
    .digest("hex");
}

export function loadContextCache(root: string): Map<string, string> {
  const cache = new Map<string, string>();
  try {
    const raw = readFileSync(contextCachePath(root), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { k?: string; v?: string };
        if (entry.k && typeof entry.v === "string") cache.set(entry.k, entry.v);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no cache yet
  }
  return cache;
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

export function loadAssetCache(root: string): Map<string, string> {
  const cache = new Map<string, string>();
  try {
    const raw = readFileSync(assetCachePath(root), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { k?: string; v?: string };
        if (entry.k && typeof entry.v === "string") cache.set(entry.k, entry.v);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no cache yet
  }
  return cache;
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

  const lines = rows.map((r) =>
    JSON.stringify({ k: assetCacheKey(r.content_hash, r.title), v: r.content })
  );
  lines.sort();
  writeFileSync(assetCachePath(root), lines.join("\n") + "\n", "utf-8");
}

/**
 * Drop sidecar entries nothing can reach any more.
 *
 * The caches are keyed by content — an asset by `${content_hash}:${title}`, a
 * chunk context by a hash of title/heading/body — so deleting a file does not
 * remove its entry, it just makes it unreachable. `saveAssetCache` and
 * `saveContextCache` rebuild from the DB and would clear it, but they only run
 * on an `--embeddings` pass, and deliberately so: they exclude placeholder rows,
 * so rebuilding on a keyless machine would empty the cache for everyone.
 *
 * Pruning by reachability is safe where rebuilding is not. It asks only whether
 * a key still corresponds to something in the index, which is true regardless of
 * whether this machine can generate descriptions. Left alone, the file grows
 * forever and a deletion is never quite a deletion — the description of a
 * removed image stays in a tracked file.
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

  const prune = (path: string, live: Set<string>): number => {
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
        return !entry.k || live.has(entry.k);
      } catch {
        return true; // leave malformed lines alone; not ours to discard
      }
    });
    if (kept.length === lines.length) return 0;
    writeFileSync(path, kept.length ? kept.join("\n") + "\n" : "", "utf-8");
    return lines.length - kept.length;
  };

  try {
    const assetRows = db
      .prepare(
        `SELECT content_hash, title FROM documents
         WHERE asset_type != 'markdown' AND content_hash IS NOT NULL`
      )
      .all() as { content_hash: string; title: string }[];
    removed.assets = prune(
      assetCachePath(root),
      new Set(assetRows.map((r) => assetCacheKey(r.content_hash, r.title)))
    );

    const chunkRows = db
      .prepare(
        `SELECT c.heading, c.content, d.title
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.asset_type = 'markdown'`
      )
      .all() as { heading: string; content: string; title: string }[];
    removed.contexts = prune(
      contextCachePath(root),
      new Set(chunkRows.map((r) => chunkContextKey(r.title, r.heading, r.content)))
    );
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

  const lines = rows.map((r) =>
    JSON.stringify({ k: chunkContextKey(r.title, r.heading, r.content), v: r.context })
  );
  lines.sort(); // stable ordering keeps git diffs minimal
  writeFileSync(contextCachePath(root), lines.join("\n") + "\n", "utf-8");
}

