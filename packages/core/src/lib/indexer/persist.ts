/**
 * The markdown write phase: one immediate transaction that leaves the index
 * agreeing with what the parse phase read.
 *
 * Four things happen in here and all four must be atomic together, which is
 * why they share a transaction rather than getting a function each: documents
 * (with their tags, FTS rows and chunks), the deletion sweep, and the full
 * re-resolution of the link graph. A crash between any two of them would leave
 * links pointing at document ids that no longer exist.
 *
 * `immediate()` rather than plain `transaction()`: this transaction always
 * writes, and a deferred transaction that upgrades read→write mid-flight fails
 * instantly with SQLITE_BUSY under contention, regardless of `busy_timeout`.
 */
import type { Database } from "bun:sqlite";

import { chunkDocument } from "../chunker.js";
import { chunkContextKey } from "./caches.js";
import { extractWikiLinks, resolveAlias, createWikiLinkResolver } from "./links.js";
import type { ExistingDoc, IndexRun, ParseResult } from "./types.js";

/** Frontmatter values arrive as strings, Dates, or nothing at all. */
function toDateString(value: any, fallback: string): string {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value);
}

/**
 * The statements this phase runs, prepared once per transaction.
 *
 * Grouped into an object rather than left as 14 locals so the write helpers
 * below can take them as one parameter — the shape is what makes them
 * extractable at all.
 */
function prepareStatements(db: Database) {
  return {
    // An upsert, not INSERT OR REPLACE: REPLACE deletes the old row, which
    // gives the document a new id and cascades its chunks away, and a chunk
    // that did not change must keep its row and its vector. accepted_mtime
    // is still passed explicitly from the existing row, the silent-edit
    // baseline this write must not reset.
    insertDoc: db.prepare(`INSERT INTO documents
      (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, file_mtime, deadline, next_review, accepted_mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title, type = excluded.type, status = excluded.status,
        relevance = excluded.relevance, summary = excluded.summary,
        created = excluded.created, updated = excluded.updated,
        content = excluded.content, content_hash = excluded.content_hash,
        asset_type = excluded.asset_type, file_mtime = excluded.file_mtime,
        deadline = excluded.deadline, next_review = excluded.next_review,
        accepted_mtime = excluded.accepted_mtime, indexed_at = excluded.indexed_at`),
    insertTag: db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)"),
    getTagId: db.prepare("SELECT id FROM tags WHERE name = ?"),
    insertDocTag: db.prepare(
      "INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)"
    ),
    getDocId: db.prepare("SELECT id FROM documents WHERE path = ?"),
    getTitle: db.prepare("SELECT title FROM documents WHERE id = ?"),
    deleteFts: db.prepare("DELETE FROM documents_fts WHERE rowid = ?"),
    deleteChunks: db.prepare("DELETE FROM chunks WHERE document_id = ?"),
    deleteTags: db.prepare("DELETE FROM document_tags WHERE document_id = ?"),
    deleteLinks: db.prepare("DELETE FROM links WHERE source_id = ?"),
    deleteDoc: db.prepare("DELETE FROM documents WHERE id = ?"),
    insertFts: db.prepare(
      "INSERT INTO documents_fts(rowid, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)"
    ),
    insertChunk: db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate)
       VALUES (?, ?, ?, ?, ?)`
    ),
    oldChunks: db.prepare("SELECT id, heading, content FROM chunks WHERE document_id = ? ORDER BY chunk_index"),
    moveChunk: db.prepare("UPDATE chunks SET chunk_index = ?, token_estimate = ? WHERE id = ?"),
    deleteChunk: db.prepare("DELETE FROM chunks WHERE id = ?"),
    insertLink: db.prepare(
      "INSERT OR IGNORE INTO links (source_id, target, target_id) VALUES (?, ?, ?)"
    ),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/**
 * Drop all MARKDOWN state ahead of a rebuild.
 *
 * Asset documents, their chunks and their vectors deliberately survive
 * `--force`: wiping them destroyed every asset description on a plain rebuild
 * and forced a full, paid vision + embedding re-run. The asset phase has its
 * own change detection and refreshes what actually changed.
 */
function wipeMarkdownState(db: Database): void {
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

/** Write one parsed file: document row, tags, FTS row, chunks. Returns its id. */
function writeDocument(
  run: IndexRun,
  st: Statements,
  file: ParseResult["files"][number],
  existing: ExistingDoc | undefined
): number | null {
  const { path, data, content, hash, mtime, isChanged } = file;
  // The title the old chunks were embedded under, read before the upsert
  // overwrites it.
  const previousTitle = existing
    ? (st.getTitle.get(existing.id) as { title: string } | null)?.title
    : undefined;

  // An updated file's old rows go first, except its chunks, which are
  // matched below. On a force rebuild everything was already dropped, so this
  // would be redundant work.
  if (isChanged && !run.force && existing) {
    st.deleteFts.run(existing.id);
    st.deleteTags.run(existing.id);
    st.deleteLinks.run(existing.id);
  }

  const deadline = data.deadline ? toDateString(data.deadline, "") || null : null;
  const nextReview = data.next_review ? toDateString(data.next_review, "") || null : null;

  st.insertDoc.run(
    path,
    String(data.title),
    String(data.type),
    String(data.status || "active"),
    String(data.relevance || "primary"),
    data.summary ? String(data.summary) : null,
    toDateString(data.created, run.now),
    toDateString(data.updated, run.now),
    content,
    hash,
    "markdown",
    mtime,
    deadline,
    nextReview,
    existing?.accepted_mtime ?? null,
    run.now
  );

  const docRow = st.getDocId.get(path) as { id: number } | null;
  if (!docRow) return null;

  const tagNames = writeTags(st, docRow.id, data.tags);

  // Aliases ride along in the FTS tags column, so an alternate name is
  // findable by keyword search even though it is not a tag.
  const aliases = Array.isArray(data.aliases) ? data.aliases.map(String) : [];
  st.insertFts.run(
    docRow.id,
    String(data.title),
    data.summary ? String(data.summary) : "",
    content,
    [...tagNames, ...aliases].join(" ")
  );

  const title = String(data.title);
  const chunks = chunkDocument({ title, content, documentId: docRow.id });

  // Match the new chunks to the document's old ones by the text they are
  // embedded from. A match keeps its row, so its id, its context and its
  // vector stay; only its position moves. Editing one section then pays for
  // that section's vector alone. The title is part of the match because it is
  // part of the embedding text (`chunkTextForEmbedding`): an old chunk is
  // keyed by the title it was embedded under, so a renamed document matches
  // nothing and is embedded afresh. The key is the one the context cache uses.
  const reusable = new Map<string, number[]>();
  for (const old of st.oldChunks.all(docRow.id) as { id: number; heading: string; content: string }[]) {
    const key = chunkContextKey(previousTitle ?? title, old.heading, old.content);
    const ids = reusable.get(key);
    if (ids) ids.push(old.id);
    else reusable.set(key, [old.id]);
  }
  for (const chunk of chunks) {
    const id = reusable.get(chunkContextKey(title, chunk.heading, chunk.content))?.shift();
    if (id !== undefined) {
      st.moveChunk.run(chunk.chunk_index, chunk.token_estimate, id);
    } else {
      st.insertChunk.run(chunk.document_id, chunk.chunk_index, chunk.heading, chunk.content, chunk.token_estimate);
    }
    run.stats.chunks++;
  }
  // What is left matched nothing. Its vectors go with the orphan sweep. A
  // kept vector's filter columns are brought up to date by
  // `syncVectorFilters` after this phase.
  for (const ids of reusable.values()) for (const id of ids) st.deleteChunk.run(id);

  return docRow.id;
}

/** Upsert this document's tags and return their names, in frontmatter order. */
function writeTags(st: Statements, docId: number, tags: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(tags)) return names;
  for (const tag of tags) {
    const name = String(tag);
    st.insertTag.run(name);
    const tagRow = st.getTagId.get(name) as { id: number } | null;
    if (tagRow) st.insertDocTag.run(docId, tagRow.id);
    names.push(name);
  }
  return names;
}

/**
 * Remove index rows whose file is gone.
 *
 * Applies to assets as well as markdown: a deleted photo or PDF that stays
 * indexed makes search return ghosts pointing at nonexistent files.
 */
function sweepDeletions(
  run: IndexRun,
  st: Statements,
  markdownOnDisk: Set<string>,
  assetsOnDisk: Set<string>
): void {
  const rows = run.db
    .prepare("SELECT id, path, asset_type FROM documents")
    .all() as { id: number; path: string; asset_type: string }[];

  for (const row of rows) {
    const onDisk =
      row.asset_type === "markdown"
        ? markdownOnDisk.has(row.path)
        : assetsOnDisk.has(row.path);
    if (onDisk) continue;
    st.deleteFts.run(row.id);
    st.deleteChunks.run(row.id);
    st.deleteTags.run(row.id);
    st.deleteLinks.run(row.id);
    st.deleteDoc.run(row.id);
    run.stats.deleted++;
  }
}

/**
 * Rebuild the ENTIRE link table, every run, changed files or not.
 *
 * Resolution depends on corpus-wide state — ambiguity between duplicate
 * basenames, aliases, whether a target exists at all — so a per-changed-file
 * incremental update goes stale as soon as an unrelated file is added, and
 * stays wrong forever after a resolver fix. Full re-resolution is cheap: it is
 * a regex pass over content already in memory-mapped pages.
 */
function rebuildLinks(run: IndexRun, st: Statements, parsed: ParseResult): void {
  run.db.run("DELETE FROM links");

  const docs = run.db
    .prepare("SELECT id, path, content FROM documents WHERE asset_type = 'markdown'")
    .all() as { id: number; path: string; content: string }[];

  const resolveLink = createWikiLinkResolver(parsed.fileMap, run.taxonomy.dirAnchors);
  for (const doc of docs) {
    for (const link of extractWikiLinks(doc.content)) {
      const targetPath =
        resolveLink(link, doc.path) ??
        resolveAlias(link, parsed.aliasMap, doc.path);
      let targetId: number | null = null;
      if (targetPath) {
        const targetRow = st.getDocId.get(targetPath) as { id: number } | null;
        targetId = targetRow?.id ?? null;
      }
      st.insertLink.run(doc.id, link, targetId);
    }
  }
}

/**
 * Apply the parse phase's findings to the database.
 *
 * `markdownOnDisk` is the full scan result, not just the parsed subset: a file
 * that was skipped as unreadable is still on disk and must not be swept.
 */
export function persistMarkdown(
  run: IndexRun,
  parsed: ParseResult,
  existingDocs: Map<string, ExistingDoc>,
  markdownOnDisk: Set<string>,
  assetsOnDisk: Set<string>
): void {
  const st = prepareStatements(run.db);
  const write = run.db.transaction(() => {
    if (run.force) wipeMarkdownState(run.db);

    for (const file of parsed.files) {
      const docId = writeDocument(run, st, file, existingDocs.get(file.path));
      if (docId === null) continue;
      if (file.isNew) run.stats.added++;
      else run.stats.updated++;
    }

    sweepDeletions(run, st, markdownOnDisk, assetsOnDisk);
    rebuildLinks(run, st, parsed);
  });
  write.immediate();
}
