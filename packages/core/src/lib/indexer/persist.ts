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

import { CHUNKER_VERSION, chunkDocument } from "../chunker.js";
import { supersedesTargets } from "../supersedes.js";
import { nameKeys } from "../name-key.js";
import { chunkContextKey } from "./caches.js";
import { applyFtsTokenizer } from "./fts.js";
import { extractWikiLinks, resolveAlias, createWikiLinkResolver } from "./links.js";
import { loadExistingDocs } from "./scan.js";
import type { ExistingDoc, IndexRun, ParseResult } from "./types.js";

/** Frontmatter values arrive as strings, Dates, or nothing at all. */
function toDateString(value: any, fallback: string): string {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString().split("T")[0];
  return String(value);
}

/** `generated_from` as stored: a non-empty string, else null (validate reports anything else). */
function generatedFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * `verification` as stored: the string as written, else null. `brain audit`
 * reads only `unverified`, the value `brain validate` accepts, compared the
 * same way (exactly), so the two cannot disagree about a document.
 */
function verification(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
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
      (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, file_mtime, deadline, next_review, accepted_mtime, generated_from, verification, indexed_at, chunker_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title, type = excluded.type, status = excluded.status,
        relevance = excluded.relevance, summary = excluded.summary,
        created = excluded.created, updated = excluded.updated,
        content = excluded.content, content_hash = excluded.content_hash,
        asset_type = excluded.asset_type, file_mtime = excluded.file_mtime,
        deadline = excluded.deadline, next_review = excluded.next_review,
        accepted_mtime = excluded.accepted_mtime, generated_from = excluded.generated_from,
        verification = excluded.verification,
        indexed_at = excluded.indexed_at, chunker_version = excluded.chunker_version`),
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
    deleteNameKeys: db.prepare("DELETE FROM name_keys WHERE document_id = ?"),
    insertNameKey: db.prepare("INSERT OR IGNORE INTO name_keys (key, document_id) VALUES (?, ?)"),
    deleteSupersedes: db.prepare("DELETE FROM supersedes WHERE source_id = ?"),
    insertSupersedes: db.prepare("INSERT OR IGNORE INTO supersedes (source_id, target, target_id) VALUES (?, ?, NULL)"),
    deleteDoc: db.prepare("DELETE FROM documents WHERE id = ?"),
    insertFts: db.prepare(
      "INSERT INTO documents_fts(rowid, title, summary, content, tags, aliases) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    insertChunk: db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    oldChunks: db.prepare("SELECT id, heading, content FROM chunks WHERE document_id = ? ORDER BY chunk_index"),
    moveChunk: db.prepare("UPDATE chunks SET chunk_index = ?, token_estimate = ?, start_line = ?, end_line = ? WHERE id = ?"),
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
  // The chunk full-text index is derived from `chunks`: rebuilt from them
  // first, so whatever state it was in, the deletes below find the entries
  // they remove, and the rows written after keep it whole.
  db.run("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
  db.run(
    "DELETE FROM documents_fts WHERE rowid IN (SELECT id FROM documents WHERE asset_type = 'markdown')"
  );
  db.run(
    "DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE asset_type = 'markdown')"
  );
  db.run("DELETE FROM links");
  db.run("DELETE FROM supersedes");
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
  // matched below, and its links, which `rebuildLinks` brings up to date as
  // a difference. On a force rebuild everything was already dropped, so this
  // would be redundant work.
  if (isChanged && !run.force && existing) {
    st.deleteFts.run(existing.id);
    st.deleteTags.run(existing.id);
    st.deleteSupersedes.run(existing.id);
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
    generatedFrom(data.generated_from),
    verification(data.verification),
    run.now,
    CHUNKER_VERSION
  );

  const docRow = st.getDocId.get(path) as { id: number } | null;
  if (!docRow) return null;

  const tagNames = writeTags(st, docRow.id, data.tags);
  // Resolved with the links, once every document is written (rebuildLinks).
  // A value of the wrong shape stores nothing; `brain validate` reports it.
  for (const target of supersedesTargets(data.supersedes) ?? []) st.insertSupersedes.run(docRow.id, target);

  // Aliases have their own column, weighted like the title; one per line, so
  // an exact alias can be read back whole.
  const aliases = Array.isArray(data.aliases) ? data.aliases.map(String) : [];
  // A changed document's keys were written for its old title and aliases.
  st.deleteNameKeys.run(docRow.id);
  for (const key of nameKeys(String(data.title), aliases)) st.insertNameKey.run(key, docRow.id);
  st.insertFts.run(
    docRow.id,
    String(data.title),
    data.summary ? String(data.summary) : "",
    content,
    tagNames.join(" "),
    aliases.join("\n")
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
      // A kept chunk can sit on other lines now: its lines move with it.
      st.moveChunk.run(chunk.chunk_index, chunk.token_estimate, chunk.start_line ?? null, chunk.end_line ?? null, id);
    } else {
      st.insertChunk.run(chunk.document_id, chunk.chunk_index, chunk.heading, chunk.content, chunk.token_estimate, chunk.start_line ?? null, chunk.end_line ?? null);
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
  existingDocs: Map<string, ExistingDoc>,
  markdownOnDisk: Set<string>,
  assetsOnDisk: Set<string>,
  sweepOnly?: ReadonlySet<string>
): void {
  // The candidates are the rows the scan loaded; every row this run wrote is
  // on disk, and a row another run committed after the scan is no evidence
  // of a deletion. A targeted run knows only the paths it was named, so only
  // those may be swept. Each candidate's id is read again here, inside the
  // transaction: a `--force` wipe already removed every markdown row (and may
  // have handed its id to a new one), so only a row that still exists is
  // swept or counted.
  for (const [path, existing] of existingDocs) {
    if (sweepOnly && !sweepOnly.has(path)) continue;
    const onDisk = existing.asset_type === "markdown" ? markdownOnDisk.has(path) : assetsOnDisk.has(path);
    if (onDisk) continue;
    const row = st.getDocId.get(path) as { id: number } | null;
    if (!row) continue;
    st.deleteFts.run(row.id);
    st.deleteChunks.run(row.id);
    st.deleteTags.run(row.id);
    st.deleteLinks.run(row.id);
    st.deleteDoc.run(row.id);
    run.stats.deleted++;
  }
}

/**
 * Re-resolve the ENTIRE link table, every run, changed files or not.
 *
 * Resolution depends on corpus-wide state — ambiguity between duplicate
 * basenames, aliases, whether a target exists at all — so a per-changed-file
 * incremental update goes stale as soon as an unrelated file is added, and
 * stays wrong forever after a resolver fix. Full re-resolution is cheap: it is
 * a regex pass over every markdown body, streamed rather than held at once.
 *
 * Only the result is incremental: the resolved set is compared with the rows
 * the table holds, and only rows that left the set, joined it or resolve to
 * another document are written. A run in which no link changed writes no
 * `links` row. Targets are always markdown paths, so their ids come from the
 * rows read here; no statement runs per link.
 */
function rebuildLinks(run: IndexRun, st: Statements, parsed: ParseResult): void {
  const docs = run.db.prepare<{ id: number; path: string; content: string }, []>(
    "SELECT id, path, content FROM documents WHERE asset_type = 'markdown'"
  );
  const resolveLink = createWikiLinkResolver(parsed.fileMap, run.taxonomy.dirAnchors);
  const idByPath = new Map<string, number>();
  const extracted: Array<{ sourceId: number; target: string; targetPath: string | null }> = [];
  for (const doc of docs.iterate()) {
    idByPath.set(doc.path, doc.id);
    for (const link of extractWikiLinks(doc.content)) {
      const targetPath = resolveLink(link, doc.path) ?? resolveAlias(link, parsed.aliasMap, doc.path);
      extracted.push({ sourceId: doc.id, target: link, targetPath });
    }
  }
  const idOf = (path: string | null) => (path === null ? null : idByPath.get(path) ?? null);

  // source_id -> target -> target_id, as resolved now. The table's key is
  // (source_id, target), so a target text is one row per source.
  const resolved = new Map<number, Map<string, number | null>>();
  for (const link of extracted) {
    const targets = resolved.get(link.sourceId) ?? new Map<string, number | null>();
    if (!targets.has(link.target)) targets.set(link.target, idOf(link.targetPath));
    resolved.set(link.sourceId, targets);
  }

  const stored = run.db.prepare<{ source_id: number; target: string; target_id: number | null }, []>(
    "SELECT source_id, target, target_id FROM links"
  ).all();
  const deleteLink = run.db.prepare("DELETE FROM links WHERE source_id = ? AND target = ?");
  const updateLink = run.db.prepare("UPDATE links SET target_id = ? WHERE source_id = ? AND target = ?");
  for (const row of stored) {
    const targets = resolved.get(row.source_id);
    if (!targets?.has(row.target)) {
      deleteLink.run(row.source_id, row.target);
      continue;
    }
    const targetId = targets.get(row.target)!;
    targets.delete(row.target);
    if (targetId !== row.target_id) updateLink.run(targetId, row.source_id, row.target);
  }
  // What is left was not stored yet.
  for (const [sourceId, targets] of resolved) {
    for (const [target, targetId] of targets) st.insertLink.run(sourceId, target, targetId);
  }

  // `supersedes` targets resolve the same way, re-resolved on every run so a
  // renamed or newly added target is picked up without touching the source.
  // Only a row whose resolved target changed is written.
  const update = run.db.prepare("UPDATE supersedes SET target_id = ? WHERE source_id = ? AND target = ?");
  const rows = run.db
    .prepare("SELECT s.source_id, s.target, s.target_id, d.path FROM supersedes s JOIN documents d ON d.id = s.source_id")
    .all() as { source_id: number; target: string; target_id: number | null; path: string }[];
  for (const row of rows) {
    const targetPath = resolveLink(row.target, row.path) ?? resolveAlias(row.target, parsed.aliasMap, row.path);
    const targetId = idOf(targetPath);
    const next = targetId === row.source_id ? null : targetId;
    if (next !== row.target_id) update.run(next, row.source_id, row.target);
  }
}

/** Does the index hold exactly the rows a run planned from? */
function sameRows(planned: Map<string, ExistingDoc>, current: Map<string, ExistingDoc>): boolean {
  if (planned.size !== current.size) return false;
  for (const [path, row] of current) {
    const was = planned.get(path);
    if (!was || was.id !== row.id || was.asset_type !== row.asset_type || was.content_hash !== row.content_hash ||
        was.chunker_version !== row.chunker_version || was.accepted_mtime !== row.accepted_mtime ||
        was.stat_fingerprint !== row.stat_fingerprint) return false;
  }
  return true;
}

/**
 * Apply the parse phase's findings to the database.
 *
 * `markdownOnDisk` is the full scan result, not just the parsed subset: a file
 * that was skipped as unreadable is still on disk and must not be swept.
 *
 * Returns false, having written nothing, when a targeted run's plan no longer
 * holds. Such a run trusts the rows it read before this transaction for every
 * path it was not named, and for whether a named path is new; another
 * connection that committed since (an MCP server, a git hook) can have
 * inserted, changed or removed one. The rows are read again here, under the
 * write lock, and any difference sends the caller to a complete run.
 */
export function persistMarkdown(
  run: IndexRun,
  parsed: ParseResult,
  existingDocs: Map<string, ExistingDoc>,
  markdownOnDisk: Set<string>,
  assetsOnDisk: Set<string>,
  /** A targeted run's named paths: only these rows may be swept. */
  sweepOnly?: ReadonlySet<string>
): boolean {
  const st = prepareStatements(run.db);
  const write = run.db.transaction(() => {
    if (sweepOnly && !sameRows(existingDocs, loadExistingDocs(run.db))) return false;
    applyFtsTokenizer(run);
    if (run.force) wipeMarkdownState(run.db);

    for (const file of parsed.files) {
      const docId = writeDocument(run, st, file, existingDocs.get(file.path));
      if (docId === null) continue;
      if (file.isNew) run.stats.added++;
      else run.stats.updated++;
    }

    sweepDeletions(run, st, existingDocs, markdownOnDisk, assetsOnDisk, sweepOnly);
    rebuildLinks(run, st, parsed);
    return true;
  });
  return write.immediate();
}
