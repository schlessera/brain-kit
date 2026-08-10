import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { createHash } from "crypto";
import matter from "gray-matter";
import { readFileSync, writeFileSync, statSync } from "fs";
import { resolve } from "path";

import { ASSET_EXTENSIONS } from "./types.js";
import type { Asset, DocumentType } from "./types.js";
import type { EmbeddingProvider } from "./seams.js";
import type { Enrichment } from "./enrichment.js";
import type { Taxonomy } from "./taxonomy.js";
import { DEFAULT_DIR_ANCHORS } from "./config.js";
import {
  hasVecSupport,
  getMeta,
  setMeta,
  initVecSupport,
  embeddingIdentityMatches,
} from "./db.js";
import { chunkDocument, chunkTextForEmbedding } from "./chunker.js";

export interface IndexStats {
  total: number;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  chunks: number;
  embeddings: number;
  assets: number;
}

/**
 * Everything the indexer needs beyond the database handle. `root` and
 * `taxonomy` replace the module-level ROOT/DB_PATH and the hardcoded
 * type/dir/exclusion/anchor tables of the reference brain. The embedding
 * provider and enrichment are injected seams (config resolves the built-ins);
 * absent, embedding/description work degrades exactly as the source did with
 * no API key configured.
 */
export interface IndexOptions {
  root: string;
  taxonomy: Taxonomy;
  force?: boolean;
  quiet?: boolean;
  /** Run the embedding pass (chunk vectors + multimodal asset vectors). */
  embeddings?: boolean;
  /** Injected embedding provider; absent → no vectors are written. */
  provider?: EmbeddingProvider;
  /** Injected enrichment (asset descriptions + chunk contexts); absent → degrades. */
  enrichment?: Enrichment;
}

/**
 * Scan `root` for *.md files, excluding configured dirs and files.
 */
export function getMarkdownFiles(root: string, taxonomy: Taxonomy): string[] {
  const glob = new Glob("**/*.md");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: root })) {
    if (!taxonomy.isExcludedPath(path)) {
      files.push(path);
    }
  }
  return files.sort();
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

/**
 * Scan `root` for image and PDF assets, excluding configured dirs. Asset
 * type and title come from the taxonomy resolver (typeForPath / assetTitleFor),
 * which replaces the reference brain's inferAssetType/deriveAssetTitle tables.
 */
export function getAssetFiles(root: string, taxonomy: Taxonomy): Asset[] {
  // Include both lowercase and uppercase extensions (.jpg and .JPG, etc.)
  const exts = ASSET_EXTENSIONS.map((e) => e.slice(1));
  const allExts = [...exts, ...exts.map((e) => e.toUpperCase())];
  const pattern = `**/*.{${allExts.join(",")}}`;
  const glob = new Glob(pattern);
  const assets: Asset[] = [];

  for (const path of glob.scanSync({ cwd: root })) {
    if (taxonomy.isExcludedPath(path.toLowerCase())) continue;

    // Skip Zone.Identifier files (Windows WSL metadata)
    if (path.includes(":Zone.Identifier")) continue;

    const ext = "." + path.split(".").pop()!.toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) continue;

    const fullPath = resolve(root, path);
    let sizeBytes: number;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      continue;
    }

    assets.push({
      path,
      mimeType,
      title: taxonomy.assetTitleFor(path),
      type: taxonomy.typeForPath(path),
      sizeBytes,
    });
  }

  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Extract [[wiki-link]] targets from markdown content.
 */
export function extractWikiLinks(content: string): string[] {
  // Strip fenced and inline code first — `[['a',1]]` in a code sample is not a link
  const stripped = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

  const regex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    // Support [[target|display text]] — the target is before the pipe
    const target = match[1].split("|")[0].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

/**
 * Resolve a wiki-link target to a file path using a filename map.
 *
 * Resolution order:
 * 1. Qualified targets containing "/" match by path suffix ([[bookshelf/research]])
 * 2. Unique basename match anywhere in the corpus
 * 3. Ambiguous basenames resolve to a same-directory sibling of sourcePath
 * 4. Otherwise unresolved (null) — never guess among multiple candidates;
 *    the old first-match behavior silently wired 52 [[research]] links to
 *    the alphabetically first research.md in the repo.
 *
 * The directory-anchor list (which file a `[[dir]]` link resolves to) comes
 * from the taxonomy resolver — `taxonomy.dirAnchors` — rather than a hardcoded
 * constant. Defaults to the core anchor set for standalone callers/tests.
 */
export function resolveWikiLink(
  target: string,
  fileMap: Map<string, string>,
  sourcePath?: string,
  dirAnchors: string[] = DEFAULT_DIR_ANCHORS
): string | null {
  // Drop heading fragments: [[file#section]] links to the file
  target = target.split("#")[0].trim();
  if (!target) return null;

  // A trailing slash is an explicit directory link: it resolves to the
  // directory's anchor file (dirAnchors order), never to a same-named .md file.
  // Handles both a qualified dir path ([[projects/active/bookshelf/]]) and a
  // bare dir name ([[bookshelf/]]).
  if (target.endsWith("/")) {
    const dir = target.replace(/\/+$/, "");
    if (!dir) return null;
    return resolveDirAnchor(dir, fileMap, dirAnchors, sourcePath);
  }

  // Qualified link: path suffix match
  if (target.includes("/")) {
    const suffix = target.endsWith(".md") ? target : `${target}.md`;
    for (const [path] of fileMap) {
      if (path === suffix || path.endsWith("/" + suffix)) return path;
    }
    return null;
  }

  const candidates: string[] = [];
  for (const [path] of fileMap) {
    const basename = path.replace(/\.md$/, "").split("/").pop();
    if (basename === target) candidates.push(path);
  }
  // Fall back to _index resolution ([[index]] -> studies/_index.md)
  if (candidates.length === 0) {
    for (const [path] of fileMap) {
      const basename = path.replace(/\.md$/, "").split("/").pop();
      if (basename === `_${target}`) candidates.push(path);
    }
  }
  // Directory link: [[bookshelf]] -> projects/active/bookshelf/<anchor>.
  // One anchor per matching directory, by dirAnchors preference.
  if (candidates.length === 0) {
    const dirs = new Set<string>();
    for (const [path] of fileMap) {
      const segs = path.split("/");
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i] === target) {
          dirs.add(segs.slice(0, i + 1).join("/"));
          break;
        }
      }
    }
    for (const dir of dirs) {
      for (const anchor of dirAnchors) {
        if (fileMap.has(`${dir}/${anchor}`)) {
          candidates.push(`${dir}/${anchor}`);
          break;
        }
      }
    }
  }

  return disambiguateCandidates(candidates, sourcePath);
}

/**
 * Pick one path among ambiguous candidates from the source's position:
 * 1. The source's namesake subdirectory (studies/{slug}.md registry files link
 *    into studies/{slug}/)
 * 2. Walk up the source's ancestor directories (closest first); the first
 *    scope containing exactly one candidate wins. Covers same-directory
 *    siblings and "nearest _index" references; multiple candidates inside
 *    the nearest scope stay ambiguous (null).
 */
function disambiguateCandidates(
  candidates: string[],
  sourcePath?: string
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (sourcePath) {
    const srcBase = sourcePath.replace(/\.md$/, "");
    const namesakeSub = candidates.find((p) => p.startsWith(srcBase + "/"));
    if (namesakeSub) return namesakeSub;

    const parts = sourcePath.split("/").slice(0, -1);
    for (let depth = parts.length; depth >= 0; depth--) {
      const prefix = depth > 0 ? parts.slice(0, depth).join("/") + "/" : "";
      const within = candidates.filter((c) => c.startsWith(prefix));
      if (within.length === 1) return within[0];
      if (within.length > 1) return null;
    }
  }

  return null;
}

/**
 * Resolve an explicit directory reference to its anchor file. `dir` may be a
 * qualified path (projects/active/bookshelf) matched by full/suffix path, or a
 * bare directory name (bookshelf) matched on any single path segment. One
 * anchor per matching directory, by dirAnchors preference; ambiguity among
 * matching directories is settled from the source's position.
 */
function resolveDirAnchor(
  dir: string,
  fileMap: Map<string, string>,
  dirAnchors: string[],
  sourcePath?: string
): string | null {
  const qualified = dir.includes("/");
  const dirs = new Set<string>();
  for (const [path] of fileMap) {
    const segs = path.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      const prefix = segs.slice(0, i + 1).join("/");
      const hit = qualified ? prefix === dir || prefix.endsWith("/" + dir) : segs[i] === dir;
      if (hit) {
        dirs.add(prefix);
        break;
      }
    }
  }

  const candidates: string[] = [];
  for (const d of dirs) {
    for (const anchor of dirAnchors) {
      if (fileMap.has(`${d}/${anchor}`)) {
        candidates.push(`${d}/${anchor}`);
        break;
      }
    }
  }

  return disambiguateCandidates(candidates, sourcePath);
}

/**
 * Resolve a wiki-link via frontmatter aliases (alias -> paths), with the
 * same disambiguation rules as basename resolution.
 */
export function resolveAlias(
  target: string,
  aliasMap: Map<string, string[]>,
  sourcePath?: string
): string | null {
  const candidates = aliasMap.get(target.toLowerCase());
  if (!candidates || candidates.length === 0) return null;
  return disambiguateCandidates(candidates, sourcePath);
}

// Committed sidecar cache of LLM-generated chunk contexts, keyed by content
// hash. brain.db is gitignored, so without this a fresh clone (or db loss)
// would re-generate every context through the LLM. Rebuilt from the DB after
// every --embeddings run; consulted before generating.
function contextCachePath(root: string): string {
  return resolve(root, ".context-cache.jsonl");
}

export function chunkContextKey(title: string, heading: string, content: string): string {
  return createHash("sha256")
    .update(`${title} ${heading} ${content}`)
    .digest("hex");
}

function loadContextCache(root: string): Map<string, string> {
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

function assetCacheKey(contentHash: string, title: string): string {
  return `${contentHash}:${title}`;
}

function loadAssetCache(root: string): Map<string, string> {
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

function saveAssetCache(db: Database, root: string): void {
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

function saveContextCache(db: Database, root: string): void {
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

/** True when at least one vector is stored (cheap EXISTS probe). */
function vecStoreHasRows(db: Database): boolean {
  try {
    const row = db.prepare("SELECT EXISTS(SELECT 1 FROM vec_chunks) AS n").get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  }
}

/**
 * Incrementally index all markdown files into the database.
 */
export async function indexAll(
  db: Database,
  options: IndexOptions
): Promise<IndexStats> {
  const { root, taxonomy } = options;
  const force = options.force ?? false;
  const quiet = options.quiet ?? false;
  const wantEmbeddings = options.embeddings ?? false;
  // Injected seams. The embedding provider drives vectors; the enrichment
  // module drives asset descriptions and chunk contexts. Either absent → that
  // work degrades (same as the reference brain running without an API key).
  const provider = options.provider;
  const enrichment = options.enrichment;

  const stats: IndexStats = {
    total: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    chunks: 0,
    embeddings: 0,
    assets: 0,
  };

  const files = getMarkdownFiles(root, taxonomy);
  stats.total = files.length;
  const now = new Date().toISOString();

  // Scan assets once per run — reused by deletion detection, the asset
  // indexing phase, and the embedding self-heal backfill.
  const assetFiles = getAssetFiles(root, taxonomy);
  const assetPathsOnDisk = new Set(assetFiles.map((a) => a.path));

  // Build file map for wiki-link resolution: path -> title
  const fileMap = new Map<string, string>();
  // Frontmatter aliases: lowercased alias -> paths claiming it
  const aliasMap = new Map<string, string[]>();
  const parsedFiles: Array<{
    path: string;
    data: Record<string, any>;
    content: string;
    hash: string;
    mtime: string;
    isNew: boolean;
    isChanged: boolean;
  }> = [];

  // Get existing documents from DB. Incremental runs use this for change
  // detection; force rebuilds still need it to carry accepted_mtime baselines
  // across the wipe (otherwise every full rebuild silently resets them).
  const existingDocs = new Map<
    string,
    {
      id: number;
      content_hash: string | null;
      accepted_mtime: string | null;
      stat_fingerprint: string | null;
    }
  >();
  {
    const rows = db
      .prepare("SELECT id, path, content_hash, accepted_mtime, stat_fingerprint FROM documents")
      .all() as {
      id: number;
      path: string;
      content_hash: string | null;
      accepted_mtime: string | null;
      stat_fingerprint: string | null;
    }[];
    for (const row of rows) {
      existingDocs.set(row.path, {
        id: row.id,
        content_hash: row.content_hash,
        accepted_mtime: row.accepted_mtime,
        stat_fingerprint: row.stat_fingerprint,
      });
    }
  }

  // Parse all files and determine what changed
  for (const filePath of files) {
    const fullPath = resolve(root, filePath);

    // A file can vanish between scan and read (git operations, editors that
    // save via rename). Skip it instead of aborting the whole run; it stays
    // in `files`, so the deletion sweep below won't remove it either.
    let raw: string;
    let mtime: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
      mtime = statSync(fullPath).mtime.toISOString().split("T")[0];
    } catch (e) {
      if (!quiet) console.warn(`  SKIP: ${filePath} — unreadable (${(e as Error).message})`);
      continue;
    }
    const hash = createHash("sha256").update(raw).digest("hex");

    let data: Record<string, any>;
    let content: string;
    try {
      const parsed = matter(raw);
      data = parsed.data;
      content = parsed.content;
    } catch {
      if (!quiet) console.warn(`  SKIP: ${filePath} — invalid frontmatter`);
      continue;
    }

    if (!data.title || !data.type) {
      if (!quiet) console.warn(`  SKIP: ${filePath} — missing required frontmatter (title, type)`);
      continue;
    }

    fileMap.set(filePath, String(data.title));

    // Collect aliases for ALL files (not just changed) — link resolution
    // and FTS need the full alias space every run
    if (Array.isArray(data.aliases)) {
      for (const alias of data.aliases) {
        const key = String(alias).toLowerCase().trim();
        if (!key) continue;
        const paths = aliasMap.get(key) ?? [];
        paths.push(filePath);
        aliasMap.set(key, paths);
      }
    }

    const existing = existingDocs.get(filePath);
    const isNew = !existing;
    const isChanged = !isNew && existing!.content_hash !== hash;

    if (!force && !isNew && !isChanged) {
      stats.unchanged++;
      continue;
    }

    parsedFiles.push({
      path: filePath,
      data,
      content,
      hash,
      mtime,
      isNew,
      isChanged,
    });
  }

  // Track document IDs that need embedding
  const docIdsNeedingEmbedding: number[] = [];
  // Track deleted document IDs for vec_chunks cleanup
  const deletedDocIds: number[] = [];

  // Clear markdown vectors on force rebuild (outside transaction — virtual
  // table). Asset documents, chunks, and vectors deliberately survive force:
  // wiping them silently destroyed all asset search data on plain rebuilds
  // and forced a full (paid) vision + embedding re-run.
  if (force && hasVecSupport(db)) {
    try {
      db.run(`DELETE FROM vec_chunks WHERE chunk_id IN (
        SELECT c.id FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.asset_type = 'markdown')`);
    } catch {
      // vec_chunks may not exist yet
    }
  }

  // Main transaction for DB operations
  const runTransaction = db.transaction(() => {
    if (force) {
      // Full rebuild of markdown state only — asset documents survive (their
      // own change detection refreshes them in the asset phase)
      db.run(
        "DELETE FROM documents_fts WHERE rowid IN (SELECT id FROM documents WHERE asset_type = 'markdown')"
      );
      db.run(
        "DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE asset_type = 'markdown')"
      );
      db.run("DELETE FROM links");
      db.run("DELETE FROM document_tags");
      db.run("DELETE FROM documents WHERE asset_type = 'markdown'");
    }

    // accepted_mtime is carried over from the existing row — INSERT OR
    // REPLACE would otherwise silently reset the silent-edit baseline
    const insertDoc = db.prepare(`INSERT OR REPLACE INTO documents
      (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, file_mtime, deadline, next_review, accepted_mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
    const getTagId = db.prepare("SELECT id FROM tags WHERE name = ?");
    const insertDocTag = db.prepare(
      "INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)"
    );
    const getDocId = db.prepare("SELECT id FROM documents WHERE path = ?");

    const deleteFts = db.prepare("DELETE FROM documents_fts WHERE rowid = ?");
    const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
    const deleteTags = db.prepare("DELETE FROM document_tags WHERE document_id = ?");
    const deleteLinks = db.prepare("DELETE FROM links WHERE source_id = ?");

    const insertFts = db.prepare(
      "INSERT INTO documents_fts(rowid, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)"
    );

    const insertChunk = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate)
       VALUES (?, ?, ?, ?, ?)`
    );

    const toStr = (v: any, fallback: string): string => {
      if (!v) return fallback;
      if (v instanceof Date) return v.toISOString().split("T")[0];
      return String(v);
    };

    for (const file of parsedFiles) {
      const { path, data, content, hash, mtime, isNew, isChanged } = file;

      // For updated files, clean up old data first
      if (isChanged && !force) {
        const existing = existingDocs.get(path);
        if (existing) {
          deleteFts.run(existing.id);
          deleteChunks.run(existing.id);
          deleteTags.run(existing.id);
          deleteLinks.run(existing.id);
        }
      }

      // Optional frontmatter fields (mtime was captured at parse time,
      // before the transaction — no filesystem access in here)
      const deadline = data.deadline ? toStr(data.deadline, "") || null : null;
      const nextReview = data.next_review ? toStr(data.next_review, "") || null : null;

      // Insert/replace document
      insertDoc.run(
        path,
        String(data.title),
        String(data.type),
        String(data.status || "active"),
        String(data.relevance || "primary"),
        data.summary ? String(data.summary) : null,
        toStr(data.created, now),
        toStr(data.updated, now),
        content,
        hash,
        "markdown",
        mtime,
        deadline,
        nextReview,
        existingDocs.get(path)?.accepted_mtime ?? null,
        now
      );

      const docRow = getDocId.get(path) as { id: number } | null;
      if (!docRow) continue;

      // Insert tags
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const tagNames: string[] = [];
      for (const tag of tags) {
        const tagStr = String(tag);
        insertTag.run(tagStr);
        const tagRow = getTagId.get(tagStr) as { id: number } | null;
        if (tagRow) {
          insertDocTag.run(docRow.id, tagRow.id);
        }
        tagNames.push(tagStr);
      }

      // Insert FTS — aliases ride along in the tags column so alternate
      // names are findable via keyword search
      const aliases = Array.isArray(data.aliases) ? data.aliases.map(String) : [];
      insertFts.run(
        docRow.id,
        String(data.title),
        data.summary ? String(data.summary) : "",
        content,
        [...tagNames, ...aliases].join(" ")
      );

      // Create and insert chunks
      const chunks = chunkDocument({
        title: String(data.title),
        content,
        documentId: docRow.id,
      });
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.document_id,
          chunk.chunk_index,
          chunk.heading,
          chunk.content,
          chunk.token_estimate
        );
        stats.chunks++;
      }

      docIdsNeedingEmbedding.push(docRow.id);

      if (isNew) stats.added++;
      else stats.updated++;
    }

    // Detect deleted files: in DB but not on disk. Applies to markdown AND
    // assets — a deleted photo/PDF must leave the index too, or search
    // returns ghosts pointing at nonexistent files.
    const diskPaths = new Set(files);
    const allDbPaths = db
      .prepare("SELECT id, path, asset_type FROM documents")
      .all() as { id: number; path: string; asset_type: string }[];

    const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");
    for (const row of allDbPaths) {
      const onDisk =
        row.asset_type === "markdown"
          ? diskPaths.has(row.path)
          : assetPathsOnDisk.has(row.path);
      if (!onDisk) {
        deleteFts.run(row.id);
        deleteChunks.run(row.id);
        deleteTags.run(row.id);
        deleteLinks.run(row.id);
        deleteDoc.run(row.id);
        deletedDocIds.push(row.id);
        stats.deleted++;
      }
    }

    // Re-resolve the ENTIRE link graph every run. Resolution depends on
    // corpus-wide state (ambiguity between duplicate basenames, aliases,
    // file existence), so per-changed-file incremental updates go stale or
    // stay wrong after a resolver fix. Full re-resolution is cheap.
    const insertLink = db.prepare(
      "INSERT OR IGNORE INTO links (source_id, target, target_id) VALUES (?, ?, ?)"
    );
    db.run("DELETE FROM links");

    const allMarkdownDocs = db
      .prepare("SELECT id, path, content FROM documents WHERE asset_type = 'markdown'")
      .all() as { id: number; path: string; content: string }[];

    for (const doc of allMarkdownDocs) {
      for (const link of extractWikiLinks(doc.content)) {
        const targetPath =
          resolveWikiLink(link, fileMap, doc.path, taxonomy.dirAnchors) ??
          resolveAlias(link, aliasMap, doc.path);
        let targetId: number | null = null;
        if (targetPath) {
          const targetRow = getDocId.get(targetPath) as { id: number } | null;
          targetId = targetRow?.id ?? null;
        }
        insertLink.run(doc.id, link, targetId);
      }
    }
  });

  // Immediate: this transaction always writes — starting deferred would
  // upgrade read→write mid-transaction, which fails instantly with
  // SQLITE_BUSY under contention regardless of busy_timeout.
  runTransaction.immediate();

  // Clean up orphaned vec_chunks (outside transaction — virtual table).
  // Runs unconditionally: gating it on this run's changes left dead vectors
  // behind whenever a previous run modified documents while sqlite-vec was
  // unavailable, and dead chunk IDs quietly eat KNN candidate slots.
  //
  // NOTE: the reference brain also wiped ALL vectors here whenever the
  // configured embedding model changed, then silently re-embedded on the next
  // run. That is gone: the provider is injected now, and a provider/dimension
  // change is handled in the embedding phase below, which refuses to re-embed
  // without --force (plan/04 §1). Stored vectors from a different provider are
  // left intact so search-engine reports the mismatch instead of ranking a
  // mixed vector space.
  if (hasVecSupport(db)) {
    try {
      db.run("DELETE FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)");
    } catch {
      // vec_chunks may not exist
    }
  }

  if (!quiet) {
    console.log(
      `Indexed: ${stats.added} added, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged, ${stats.chunks} chunks`
    );
  }

  // Asset indexing phase
  const assetDocIdsNeedingEmbedding: Array<{
    docId: number;
    path: string;
    mimeType: string;
    description: string;
    docType: string;
  }> = [];

  if (wantEmbeddings) {
    const assets = assetFiles;
    if (!quiet && assets.length > 0) {
      console.log(`Discovered ${assets.length} assets for multimodal indexing...`);
    }

    const insertAssetDoc = db.prepare(`INSERT OR REPLACE INTO documents
      (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, stat_fingerprint, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertAssetChunk = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate)
       VALUES (?, ?, ?, ?, ?)`
    );
    const updateAssetChunkContent = db.prepare(
      "UPDATE chunks SET content = ? WHERE document_id = ? AND chunk_index = 0"
    );
    const updateAssetDocContent = db.prepare(
      "UPDATE documents SET content = ? WHERE id = ?"
    );
    const insertAssetFts = db.prepare(
      "INSERT INTO documents_fts(rowid, title, summary, content, tags) VALUES (?, ?, '', ?, '')"
    );
    const deleteAssetFts = db.prepare("DELETE FROM documents_fts WHERE rowid = ?");
    const getDocId = db.prepare("SELECT id FROM documents WHERE path = ?");
    const deleteAssetChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
    const updateFingerprint = db.prepare(
      "UPDATE documents SET stat_fingerprint = ? WHERE id = ?"
    );

    // Phase 1: identify changed assets and insert DB records (sync, fast).
    // The stat fingerprint fast-path skips unchanged assets without reading
    // or hashing their bytes — previously every run re-read the full asset
    // tree (hundreds of MB) just to conclude nothing changed.
    type AssetTask = { asset: Asset; raw: Buffer | null; docId: number; hash: string };
    const changedAssets: AssetTask[] = [];

    const phase1 = db.transaction(() => {
      for (const asset of assets) {
        const fullPath = resolve(root, asset.path);
        const existing = existingDocs.get(asset.path);

        let fingerprint: string;
        try {
          const st = statSync(fullPath);
          fingerprint = `${st.mtimeMs}-${st.size}`;
        } catch {
          continue; // vanished mid-run — the deletion sweep handles it next run
        }
        if (!force && existing && existing.stat_fingerprint === fingerprint) continue;

        let raw: Buffer;
        try {
          raw = readFileSync(fullPath);
        } catch {
          continue;
        }
        const hash = createHash("sha256").update(raw).digest("hex");
        const isNew = !existing;
        const isChanged = !isNew && existing!.content_hash !== hash;

        if (!isNew && !isChanged) {
          // Same bytes, new mtime (touch, re-download) — record the new
          // fingerprint so the fast path applies next run
          updateFingerprint.run(fingerprint, existing!.id);
          continue;
        }

        const descriptor = `[${asset.mimeType.startsWith("image/") ? "Image" : "PDF"}: ${asset.path}]`;

        // Clean up old data if updating
        if (isChanged && existing) {
          deleteAssetChunks.run(existing.id);
          deleteAssetFts.run(existing.id);
        }

        insertAssetDoc.run(
          asset.path,
          asset.title,
          asset.type,
          "active",
          "primary",
          null,
          now,
          now,
          descriptor,
          hash,
          asset.mimeType,
          fingerprint,
          now
        );

        const docRow = getDocId.get(asset.path) as { id: number } | null;
        if (!docRow) continue;

        insertAssetChunk.run(docRow.id, 0, asset.title, descriptor, 0);
        // Descriptor FTS row keeps the asset findable by title until a
        // description lands; finishAsset replaces it
        deleteAssetFts.run(docRow.id);
        insertAssetFts.run(docRow.id, asset.title, descriptor);
        stats.assets++;
        stats.chunks++;

        changedAssets.push({ asset, raw: Buffer.from(raw), docId: docRow.id, hash });
      }
    });
    phase1.immediate();

    // Self-heal descriptions: queue assets whose stored content is still a
    // descriptor placeholder — a previous run's vision call failed or ran
    // without enrichment. Fallback text is never persisted (and the sidecar
    // cache filters placeholders out), so these get a real retry instead of
    // being poisoned with junk forever.
    {
      const queued = new Set(changedAssets.map((t) => t.docId));
      const placeholderDocs = db
        .prepare(
          `SELECT d.id AS docId, d.path, d.title, d.type AS docType,
                  d.asset_type AS mimeType, d.content_hash AS hash
           FROM documents d
           WHERE d.asset_type != 'markdown'
             AND (d.content LIKE '[Image:%' OR d.content LIKE '[PDF:%')`
        )
        .all() as {
        docId: number;
        path: string;
        title: string;
        docType: string;
        mimeType: string;
        hash: string;
      }[];
      for (const p of placeholderDocs) {
        if (queued.has(p.docId) || !assetPathsOnDisk.has(p.path)) continue;
        changedAssets.push({
          asset: {
            path: p.path,
            mimeType: p.mimeType,
            title: p.title,
            type: p.docType as DocumentType,
            sizeBytes: 0,
          },
          raw: null, // read lazily at describe time
          docId: p.docId,
          hash: p.hash,
        });
      }
    }

    // Phase 2: generate descriptions in parallel (async, slow — vision model
    // calls). Cached descriptions (same file content + title) skip the call.
    const finishAsset = (task: AssetTask, description: string) => {
      updateAssetChunkContent.run(description, task.docId);
      updateAssetDocContent.run(description, task.docId);
      deleteAssetFts.run(task.docId);
      insertAssetFts.run(task.docId, task.asset.title, description);
      assetDocIdsNeedingEmbedding.push({
        docId: task.docId,
        path: task.asset.path,
        mimeType: task.asset.mimeType,
        description,
        docType: task.asset.type,
      });
    };
    const finishBatch = db.transaction((items: Array<[AssetTask, string]>) => {
      for (const [task, description] of items) finishAsset(task, description);
    });

    if (changedAssets.length > 0) {
      const assetCache = loadAssetCache(root);
      const cacheHits: Array<[AssetTask, string]> = [];
      const needsDescription = changedAssets.filter((task) => {
        const cached = assetCache.get(assetCacheKey(task.hash, task.asset.title));
        if (cached === undefined) return true;
        cacheHits.push([task, cached]);
        return false;
      });
      if (cacheHits.length > 0) {
        finishBatch.immediate(cacheHits);
        if (!quiet) console.log(`  Reused ${cacheHits.length} asset descriptions from cache`);
      }

      if (enrichment) {
        const DESCRIBE_CONCURRENCY = 10;
        for (let i = 0; i < needsDescription.length; i += DESCRIBE_CONCURRENCY) {
          const batch = needsDescription.slice(i, i + DESCRIBE_CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ({ asset, raw }) => {
              const buffer =
                raw ?? Buffer.from(await Bun.file(resolve(root, asset.path)).arrayBuffer());
              return enrichment.describeAsset(buffer, asset.mimeType, asset.title);
            })
          );

          const done: Array<[AssetTask, string]> = [];
          for (let j = 0; j < results.length; j++) {
            const task = batch[j];
            const result = results[j];
            if (result.status === "fulfilled") {
              done.push([task, result.value]);
              if (!quiet) console.log(`  Described: ${task.asset.path}`);
            } else {
              // Keep the descriptor placeholder — the self-heal above
              // retries the description on the next run
              if (!quiet) {
                console.warn(
                  `  SKIP description: ${task.asset.path} — ${(result.reason as Error)?.message || result.reason}`
                );
              }
            }
          }
          if (done.length > 0) finishBatch.immediate(done);
        }
      } else if (needsDescription.length > 0 && !quiet) {
        console.log(
          `  ${needsDescription.length} asset(s) left undescribed — configure a completion provider to describe them`
        );
      }
    }

    if (!quiet && stats.assets > 0) {
      console.log(`  Assets indexed: ${stats.assets}`);
    }
  }

  // Embedding step (after main transaction, since it's async)
  if (wantEmbeddings && provider && hasVecSupport(db)) {
    // Provider/dimension change guard (plan/04 §1). Vectors carry the id and
    // dimensions of the provider that produced them (index_metadata keys
    // embedding_model / embedding_dimensions — search-engine's mismatch check
    // reads embedding_model). If a DIFFERENT provider now runs against a store
    // that already holds vectors, mixing vector spaces would rank garbage — so
    // refuse to re-embed unless --force, and leave the stored vectors + their
    // metadata untouched so search-engine reports the mismatch and degrades to
    // FTS. --force drops the vectors and re-embeds under the new provider.
    const storedModel = getMeta(db, "embedding_model");
    const storedDims = getMeta(db, "embedding_dimensions");
    const hasVectors = vecStoreHasRows(db);
    const mismatch =
      hasVectors &&
      (!embeddingIdentityMatches(storedModel, provider.id) ||
        storedDims !== String(provider.dimensions));

    if (mismatch && !force) {
      if (!quiet) {
        console.warn(
          `  Embedding provider changed: stored vectors were produced by ` +
            `'${storedModel}' (dim ${storedDims}) but the configured provider is ` +
            `'${provider.id}' (dim ${provider.dimensions}). Re-run ` +
            `'brain index --embeddings --force' to drop and re-embed them ` +
            `(this re-runs paid embedding calls). Skipping the embedding pass; ` +
            `vector search stays disabled until then.`
        );
      }
    } else {
      if (mismatch && force) {
        if (!quiet) {
          console.log(
            `  Embedding provider changed to '${provider.id}' — dropping stored vectors and re-embedding (--force)`
          );
        }
        // Drop the TABLE, not just its rows: vec0 tables are fixed-width, so
        // a cross-dimension provider swap must recreate at the new width.
        try {
          db.run("DROP TABLE IF EXISTS vec_chunks");
        } catch {
          // vec_chunks may not exist
        }
        await initVecSupport(db, provider.dimensions);
      }
      // Record the producing provider so search-engine's mismatch check agrees
      // and future runs can detect a provider switch.
      setMeta(db, "embedding_model", provider.id);
      setMeta(db, "embedding_dimensions", String(provider.dimensions));

      if (!quiet) console.log("Generating embeddings...");

      // Delete old embeddings for changed documents. Batched IN-lists — the
      // ids come straight from the DB, integer-safe to interpolate.
      for (let i = 0; i < docIdsNeedingEmbedding.length; i += 500) {
        const ids = docIdsNeedingEmbedding.slice(i, i + 500).join(",");
        db.run(
          `DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${ids}))`
        );
      }

      // Get all chunks that need embedding.
      // Self-healing: embed any markdown chunk that lacks an embedding, rather than
      // only chunks from docs flagged changed this run. This covers two cases:
      //   1. Changed docs — their old embeddings were deleted just above, so their
      //      (re-created) chunks have no vec_chunks row.
      //   2. Historically-missing chunks — e.g. files indexed by the no-embeddings
      //      post-commit hook, which updates content_hash so a later --embeddings
      //      pass would otherwise treat them as "unchanged" and skip them forever.
      // Decoupling embedding coverage from change detection makes every --embeddings
      // run a backfill, closing the hook/sync race that silently starved coverage.
      const chunksToEmbed = db
        .prepare(
          `SELECT c.id, c.document_id, c.heading, c.content, c.context,
                  d.title, d.summary, d.content AS doc_content,
                  d.status AS doc_status, d.type AS doc_type
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE d.asset_type = 'markdown'
             AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
           ORDER BY c.id`
        )
        .all() as {
        id: number;
        document_id: number;
        heading: string;
        content: string;
        context: string | null;
        title: string;
        summary: string | null;
        doc_content: string;
        doc_status: string;
        doc_type: string;
      }[];

      if (chunksToEmbed.length > 0) {
        // Contextual retrieval: situate each chunk in its document before
        // embedding. Single-chunk documents reuse the frontmatter summary (the
        // chunk IS the document); multi-chunk documents get a short LLM-generated
        // blurb. Contexts persist in chunks.context, so they are generated once
        // per chunk lifetime; failures fall back to the summary and never block.
        const chunkCounts = new Map<number, number>();
        const countRows = db
          .prepare("SELECT document_id, COUNT(*) AS n FROM chunks GROUP BY document_id")
          .all() as { document_id: number; n: number }[];
        for (const row of countRows) chunkCounts.set(row.document_id, row.n);

        // Chunks whose context generation fails are deferred entirely: context
        // stays NULL and the chunk is not embedded this run, so the missing
        // vector makes the self-heal retry BOTH on the next --embeddings run.
        // Persisting a fallback here instead would never be revisited.
        const failedContext = new Set<number>();

        let needsContext = chunksToEmbed.filter((c) => c.context === null || c.context === undefined);
        if (needsContext.length > 0) {
          const CONTEXT_CONCURRENCY = 5;
          const updateChunkContext = db.prepare("UPDATE chunks SET context = ? WHERE id = ?");
          let generated = 0;

          // Cache pass: identical chunks (same title/heading/content) reuse
          // their previously generated context without an LLM call
          const contextCache = loadContextCache(root);
          let cacheHits = 0;
          needsContext = needsContext.filter((c) => {
            const cached = contextCache.get(chunkContextKey(c.title, c.heading, c.content));
            if (cached === undefined) return true;
            c.context = cached;
            updateChunkContext.run(cached, c.id);
            cacheHits++;
            return false;
          });
          if (!quiet && cacheHits > 0) console.log(`  Reused ${cacheHits} chunk contexts from cache`);

          for (let i = 0; i < needsContext.length; i += CONTEXT_CONCURRENCY) {
            const batch = needsContext.slice(i, i + CONTEXT_CONCURRENCY);
            const results = await Promise.allSettled(
              batch.map((c) => {
                // Single-chunk docs, or no enrichment configured, fall back to
                // the frontmatter summary (never blocks, never a paid call).
                if ((chunkCounts.get(c.document_id) ?? 1) <= 1 || !enrichment) {
                  return Promise.resolve(c.summary ?? "");
                }
                return enrichment.generateChunkContext(c.title, c.doc_content, c.heading, c.content);
              })
            );
            for (let j = 0; j < results.length; j++) {
              const c = batch[j];
              const result = results[j];
              if (result.status === "rejected") {
                failedContext.add(c.id);
                if (!quiet) {
                  console.warn(`  SKIP context: chunk ${c.id} — ${(result.reason as Error)?.message ?? result.reason}`);
                }
                continue;
              }
              c.context = result.value;
              updateChunkContext.run(result.value, c.id);
              if (result.value) generated++;
            }
          }

          if (!quiet && generated > 0) console.log(`  Generated ${generated} chunk contexts`);
          if (!quiet && failedContext.size > 0) {
            console.warn(`  ${failedContext.size} chunk context(s) failed — deferred to the next --embeddings run`);
          }
        }

        const embeddable = chunksToEmbed.filter((c) => !failedContext.has(c.id));

        // Prepare texts for embedding
        const texts = embeddable.map((c) =>
          chunkTextForEmbedding(c.title, c.heading, c.content, c.context)
        );

        // Batch embed with parallel API calls
        const BATCH_SIZE = 50;
        const CONCURRENCY = 5;
        const insertVec = db.prepare(
          "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, ?, ?)"
        );
        // One transaction per completed batch instead of one autocommit per row
        const insertVecBatch = db.transaction(
          (rows: Array<{ chunkId: number; embedding: Uint8Array; isArchived: number; docType: string }>) => {
            for (const r of rows) insertVec.run(r.chunkId, r.embedding, r.isArchived, r.docType);
          }
        );

        // Build batch descriptors
        const batches: Array<{ texts: string[]; chunks: typeof embeddable }> = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          batches.push({
            texts: texts.slice(i, i + BATCH_SIZE),
            chunks: embeddable.slice(i, i + BATCH_SIZE),
          });
        }

        // Process batches with bounded concurrency. A batch whose retries are
        // exhausted (e.g. daily quota) is skipped, not fatal — the self-healing
        // backfill picks its chunks up on the next --embeddings run.
        let skippedBatches = 0;
        for (let i = 0; i < batches.length; i += CONCURRENCY) {
          const concurrent = batches.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            concurrent.map((b) => provider.embed(b.texts))
          );
          for (let b = 0; b < results.length; b++) {
            const result = results[b];
            if (result.status === "rejected") {
              skippedBatches++;
              if (!quiet) {
                console.warn(`  SKIP embed batch: ${(result.reason as Error)?.message ?? result.reason}`);
              }
              continue;
            }
            const embeddings = result.value;
            const batchChunks = concurrent[b].chunks;
            const rows = embeddings.map((embedding, j) => ({
              chunkId: batchChunks[j].id,
              embedding: new Uint8Array(embedding.buffer),
              isArchived: batchChunks[j].doc_status === "archived" ? 1 : 0,
              docType: batchChunks[j].doc_type,
            }));
            insertVecBatch.immediate(rows);
            stats.embeddings += rows.length;
          }
        }

        if (!quiet) console.log(`  Embedded ${stats.embeddings} text chunks`);
        if (!quiet && skippedBatches > 0) {
          console.warn(`  ${skippedBatches} batch(es) skipped on errors — rerun with --embeddings to backfill`);
        }
      }

      // Self-healing backfill: queue any on-disk asset whose chunk lacks an
      // embedding but wasn't flagged changed this run. Mirrors the markdown
      // self-heal above — covers assets left with a content_hash but no vector by
      // a prior --embeddings run where the embed call failed (rate limit) or ran
      // without a working provider. Reuses the description already stored on the
      // chunk, so no vision re-description (the expensive part) is needed.
      {
        const alreadyQueued = new Set(assetDocIdsNeedingEmbedding.map((a) => a.docId));
        const missingAssets = db.prepare(
          `SELECT d.id AS docId, d.path AS path, d.asset_type AS mimeType, d.type AS docType, c.content AS description
           FROM documents d
           JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0
           WHERE d.asset_type != 'markdown'
             AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
           ORDER BY d.id`
        ).all() as { docId: number; path: string; mimeType: string; docType: string; description: string }[];
        for (const m of missingAssets) {
          // Skip assets already queued this run, and stale DB rows whose file is gone.
          if (alreadyQueued.has(m.docId) || !assetPathsOnDisk.has(m.path)) continue;
          assetDocIdsNeedingEmbedding.push({
            docId: m.docId,
            path: m.path,
            mimeType: m.mimeType,
            description: m.description || m.path,
            docType: m.docType,
          });
        }
      }

      // Embed multimodal assets with bounded concurrency
      if (assetDocIdsNeedingEmbedding.length > 0) {
        if (!quiet) console.log(`  Embedding ${assetDocIdsNeedingEmbedding.length} assets...`);

        const ASSET_CONCURRENCY = 10;
        const insertVecAsset = db.prepare(
          "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, 0, ?)"
        );

        // Clean old embeddings for the queued assets (batched IN-lists)
        for (let i = 0; i < assetDocIdsNeedingEmbedding.length; i += 500) {
          const ids = assetDocIdsNeedingEmbedding
            .slice(i, i + 500)
            .map((a) => a.docId)
            .join(",");
          db.run(
            `DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${ids}))`
          );
        }

        // Prepare asset tasks: resolve chunk IDs
        const getAssetChunkId = db.prepare(
          "SELECT id FROM chunks WHERE document_id = ? AND chunk_index = 0"
        );
        const assetTasks = assetDocIdsNeedingEmbedding.map((asset) => {
          const chunkRow = getAssetChunkId.get(asset.docId) as { id: number } | null;
          return { ...asset, chunkId: chunkRow?.id ?? null };
        }).filter((a) => a.chunkId !== null);

        // Embed assets in parallel batches. A provider without embedImage/
        // embedPdf degrades to embedding the text description (plan/04 §1).
        for (let i = 0; i < assetTasks.length; i += ASSET_CONCURRENCY) {
          const batch = assetTasks.slice(i, i + ASSET_CONCURRENCY);

          const results = await Promise.allSettled(
            batch.map(async (asset) => {
              const file = Bun.file(resolve(root, asset.path));
              const buffer = Buffer.from(await file.arrayBuffer());
              if (asset.mimeType === "application/pdf") {
                return provider.embedPdf
                  ? provider.embedPdf(buffer, asset.description)
                  : (await provider.embed([asset.description]))[0];
              } else {
                return provider.embedImage
                  ? provider.embedImage(buffer, asset.mimeType, asset.description)
                  : (await provider.embed([asset.description]))[0];
              }
            })
          );
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const asset = batch[j];
            if (result.status === "fulfilled") {
              insertVecAsset.run(asset.chunkId, new Uint8Array(result.value.buffer), asset.docType);
              stats.embeddings++;
              if (!quiet) console.log(`    Embedded: ${asset.path}`);
            } else {
              console.warn(`    SKIP embedding: ${asset.path} — ${(result.reason as Error)?.message || result.reason}`);
            }
          }
        }
      }
    }

    // Persist both sidecar caches unconditionally at the end of every
    // embeddings run — they mirror the DB, so this also bootstraps them on
    // runs where nothing changed (and on a mismatch-skip run, still banks any
    // asset descriptions produced above).
    try {
      saveContextCache(db, root);
      saveAssetCache(db, root);
    } catch (e) {
      if (!quiet) console.warn(`  Could not write sidecar caches: ${(e as Error).message}`);
    }
  }

  return stats;
}
