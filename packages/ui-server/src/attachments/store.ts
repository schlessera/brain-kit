import type { Database } from "bun:sqlite";
import {
  ATTACHMENT_DIR,
  ATTACHMENT_GRACE_MS,
  ATTACHMENT_UNBOUND_TTL_MS,
  type AttachmentFile,
  type AttachmentKind,
  type AttachmentReader,
  type SharedFileMeta,
} from "@schlessera/brain-ui-sdk/protocol";
import type { AttachmentReadOutcome, AttachmentReadResult } from "@schlessera/brain-ui-sdk/tool-contracts";

/**
 * Ownership and accounting records of composer originals (#3153,
 * docs/plans/chat-attachments.md §6.3–6.7). Every function here runs inside a
 * caller's transaction: the draft store's, on the write worker, so a save, an
 * acceptance and a sweep mark see one serialized state.
 *
 * Reference owners: `draft` (owner_id = draft id, the current revision's
 * binding), `outgoing` (owner_id = draft id; every file any of the draft's
 * outgoing snapshots owns) and `message` (owner_id = session id).
 */

export type AttachmentOwner = "draft" | "outgoing" | "message";

export interface AttachmentRow {
  file_id: string;
  draft_id: string;
  sha256: string;
  bytes: number;
  stored_name: string;
  incoming_name: string | null;
  media_type: string;
  kind: AttachmentKind;
  reader: AttachmentReader;
  track_rejected: 0 | 1;
  track_json: string | null;
  state: "stored" | "deleting" | "missing";
  created_at: number;
  ever_referenced: 0 | 1;
  unreferenced_since: number | null;
}

/** What the upload route hands over once the bytes are published. */
export interface NewAttachment {
  fileId: string;
  sha256: string;
  bytes: number;
  storedName: string;
  incomingName: string | null;
  mediaType: string;
  kind: AttachmentKind;
  reader: AttachmentReader;
  trackRejected: boolean;
  track: SharedFileMeta | null;
}

export const FILE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const COLUMNS = "file_id, draft_id, sha256, bytes, stored_name, incoming_name, media_type, kind, reader, track_rejected, track_json, state, created_at, ever_referenced, unreferenced_since";

export function attachmentPath(fileId: string, name: string): string {
  return `${ATTACHMENT_DIR}/${fileId}/${name}`;
}

export function toAttachmentFile(row: AttachmentRow): AttachmentFile {
  let track: SharedFileMeta | undefined;
  if (row.track_json) {
    try { track = JSON.parse(row.track_json) as SharedFileMeta; } catch { /* A corrupt record claims no track. */ }
  }
  return {
    fileId: row.file_id,
    name: row.stored_name,
    ...(row.incoming_name ? { incomingName: row.incoming_name } : {}),
    path: attachmentPath(row.file_id, row.stored_name),
    mediaType: row.media_type,
    bytes: row.bytes,
    sha256: row.sha256,
    kind: row.kind,
    reader: row.reader,
    ...(row.track_rejected ? { trackRejected: true as const } : {}),
    ...(track && row.kind === "track" ? { track } : {}),
  };
}

export function readAttachment(db: Database, fileId: string): AttachmentRow | null {
  return db.query(`SELECT ${COLUMNS} FROM attachment_files WHERE file_id = ?`).get(fileId) as AttachmentRow | null;
}

export function readAttachments(db: Database, fileIds: readonly string[]): Map<string, AttachmentRow> {
  const rows = new Map<string, AttachmentRow>();
  for (const id of fileIds) {
    const row = readAttachment(db, id);
    if (row) rows.set(id, row);
  }
  return rows;
}

export function hasAnyRef(db: Database, fileId: string): boolean {
  return db.query("SELECT 1 FROM attachment_refs WHERE file_id = ? LIMIT 1").get(fileId) !== null;
}

/**
 * Replace one owner's references with exactly `fileIds`. The caller has
 * already checked that each new file is `stored` with the right lineage, in
 * this same transaction, so a file the sweep marked cannot be bound. A file
 * left with no reference starts its seven-day clock now.
 */
export function setRefs(db: Database, owner: AttachmentOwner, ownerId: string, fileIds: readonly string[], at: number): void {
  const previous = (db.query("SELECT file_id FROM attachment_refs WHERE owner = ? AND owner_id = ?").all(owner, ownerId) as { file_id: string }[])
    .map((r) => r.file_id);
  const keep = new Set(fileIds);
  for (const id of previous) {
    if (keep.has(id)) continue;
    db.prepare("DELETE FROM attachment_refs WHERE file_id = ? AND owner = ? AND owner_id = ?").run(id, owner, ownerId);
    if (!hasAnyRef(db, id)) db.prepare("UPDATE attachment_files SET unreferenced_since = ? WHERE file_id = ?").run(at, id);
  }
  for (const id of fileIds) addRef(db, id, owner, ownerId, at);
}

/** Insert one reference. Rebinding cancels any pending collection. */
export function addRef(db: Database, fileId: string, owner: AttachmentOwner, ownerId: string, at: number): void {
  db.prepare("INSERT OR IGNORE INTO attachment_refs (file_id, owner, owner_id, created_at) VALUES (?, ?, ?, ?)").run(fileId, owner, ownerId, at);
  db.prepare("UPDATE attachment_files SET ever_referenced = 1, unreferenced_since = NULL WHERE file_id = ?").run(fileId);
}

/**
 * The files counted against one draft's envelope at upload: everything its
 * current revision references, plus uploads for it that no save has bound yet
 * and that are still inside their one-hour window. So a burst of uploads
 * cannot exceed the envelope before a save names them. Files its outgoing
 * snapshots own are not counted: each snapshot is its own message, checked
 * against the envelope when a save lists it, and the newer composer revision
 * keeps a whole envelope of its own (#3588).
 */
export function draftEnvelope(db: Database, draftId: string, at: number): { count: number; bytes: number } {
  const row = db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM attachment_files f
     WHERE f.draft_id = ?1 AND f.state = 'stored' AND (
       EXISTS (SELECT 1 FROM attachment_refs r WHERE r.file_id = f.file_id AND r.owner = 'draft' AND r.owner_id = ?1)
       OR (f.ever_referenced = 0 AND f.created_at >= ?2
           AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE r.file_id = f.file_id)))`
  ).get(draftId, at - ATTACHMENT_UNBOUND_TTL_MS) as { n: number; b: number };
  return { count: row.n, bytes: row.b };
}

/**
 * Everything the attachment pool charges: every recorded original in any
 * state (grace-period and missing ones included), every live reservation and
 * the legacy draft image BLOBs. There is no persisted derivative yet.
 */
export function poolCharged(db: Database): number {
  const row = db.query(
    `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM attachment_files)
          + (SELECT COALESCE(SUM(bytes), 0) FROM attachment_reservations)
          + (SELECT COALESCE(SUM(size_bytes), 0) FROM session_draft_attachments) AS total`
  ).get() as { total: number };
  return row.total;
}

/** Original bytes live drafts and their outgoing snapshots reference (the draft sub-limit's share). */
export function draftReferencedBytes(db: Database): number {
  const row = db.query(
    `SELECT COALESCE(SUM(bytes), 0) AS total FROM attachment_files f
     WHERE EXISTS (SELECT 1 FROM attachment_refs r WHERE r.file_id = f.file_id AND r.owner IN ('draft', 'outgoing'))`
  ).get() as { total: number };
  return row.total;
}

export function insertAttachment(db: Database, draftId: string, file: NewAttachment, principalId: string, at: number): void {
  db.prepare(
    `INSERT INTO attachment_files (file_id, draft_id, sha256, bytes, stored_name, incoming_name, media_type, kind, reader,
       track_rejected, track_json, state, created_at, created_by, ever_referenced, unreferenced_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, 0, NULL)`
  ).run(file.fileId, draftId, file.sha256, file.bytes, file.storedName, file.incomingName, file.mediaType, file.kind, file.reader,
    file.trackRejected ? 1 : 0, file.track ? JSON.stringify(file.track) : null, at, principalId);
}

/**
 * Sweep step 1 (§6.7): in the caller's immediate transaction, re-select the
 * eligible files, confirm each has no reference, and mark it `deleting`. A
 * marked file can never be bound again. Files left `deleting` by an earlier
 * run (a restart between mark and unlink) are returned again.
 */
export function markForDeletion(db: Database, at: number): Array<{ fileId: string; state: "deleting" | "missing" }> {
  const eligible = db.query(
    `SELECT file_id, state FROM attachment_files f
     WHERE state IN ('stored', 'missing')
       AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE r.file_id = f.file_id)
       AND ((ever_referenced = 0 AND created_at < ?1)
         OR (ever_referenced = 1 AND unreferenced_since IS NOT NULL AND unreferenced_since < ?2))`
  ).all(at - ATTACHMENT_UNBOUND_TTL_MS, at - ATTACHMENT_GRACE_MS) as { file_id: string; state: "stored" | "missing" }[];
  const marked: Array<{ fileId: string; state: "deleting" | "missing" }> = [];
  for (const row of eligible) {
    // Re-checked per row inside the same transaction: a reference inserted
    // since the select would already have been serialized before it.
    if (hasAnyRef(db, row.file_id)) continue;
    if (row.state === "stored") db.prepare("UPDATE attachment_files SET state = 'deleting' WHERE file_id = ? AND state = 'stored'").run(row.file_id);
    marked.push({ fileId: row.file_id, state: row.state === "missing" ? "missing" : "deleting" });
  }
  const leftover = db.query("SELECT file_id FROM attachment_files WHERE state = 'deleting'").all() as { file_id: string }[];
  for (const { file_id } of leftover) if (!marked.some((m) => m.fileId === file_id)) marked.push({ fileId: file_id, state: "deleting" });
  return marked;
}

/** Sweep step 2's record half: forget files whose directory is gone. */
export function forgetDeleted(db: Database, fileIds: readonly string[]): void {
  for (const id of fileIds) {
    const gone = db.prepare("DELETE FROM attachment_files WHERE file_id = ? AND state IN ('deleting', 'missing')").run(id).changes > 0;
    db.prepare("DELETE FROM attachment_receipts WHERE file_id = ?").run(id);
    if (gone) db.prepare("DELETE FROM attachment_reads WHERE file_id = ?").run(id);
  }
}

/** One recorded `read_attachment` call (#3154). Internal and UI data only; never provider context. */
export interface AttachmentReadRecord {
  fileId: string;
  sessionId: string;
  turnId: string;
  outcome: Exclude<AttachmentReadOutcome, "refused">;
  scope: AttachmentReadResult["scope"] | null;
}

export function insertAttachmentRead(db: Database, read: AttachmentReadRecord, at: number): void {
  db.prepare("INSERT INTO attachment_reads (file_id, session_id, turn_id, outcome, scope_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(read.fileId, read.sessionId, read.turnId, read.outcome, read.scope ? JSON.stringify(read.scope) : null, at);
}

/** The recorded reads of one session's originals, oldest first. */
export function listAttachmentReads(db: Database, sessionId: string): Array<AttachmentReadRecord & { at: number }> {
  const rows = db.query("SELECT file_id, session_id, turn_id, outcome, scope_json, created_at FROM attachment_reads WHERE session_id = ? ORDER BY rowid")
    .all(sessionId) as Array<{ file_id: string; session_id: string; turn_id: string; outcome: AttachmentReadRecord["outcome"]; scope_json: string | null; created_at: number }>;
  return rows.map((r) => {
    let scope: AttachmentReadRecord["scope"] = null;
    try { scope = r.scope_json ? JSON.parse(r.scope_json) as AttachmentReadRecord["scope"] : null; } catch { /* A corrupt row claims no scope. */ }
    return { fileId: r.file_id, sessionId: r.session_id, turnId: r.turn_id, outcome: r.outcome, scope, at: r.created_at };
  });
}
