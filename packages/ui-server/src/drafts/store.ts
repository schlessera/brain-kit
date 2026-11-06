import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_POOL_DEFAULT_BYTES,
  type AttachmentErrorResponse,
  type AttachmentFile,
  type DraftOutgoing,
  type DraftSnapshot,
  type DraftSnapshotWrite,
  DRAFT_PREVIEW_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
  SESSION_DRAFT_LIMITS,
  type Draft,
  type DraftAttachmentResponse,
  type DraftBindResponse,
  type DraftErrorResponse,
  type DraftListResponse,
  type DraftRef,
  type DraftSaveResponse,
  type DraftSummary,
  type SessionDraftLimits,
} from "@schlessera/brain-ui-sdk/protocol";

import { createDraftWrites } from "./writes.js";
import {
  addRef, draftEnvelope, draftReferencedBytes, FILE_ID, forgetDeleted, hasAnyRef, insertAttachment, insertAttachmentRead, listAttachmentReads, markForDeletion,
  poolCharged, readAttachment, readAttachments, setRefs, toAttachmentFile, type NewAttachment,
} from "../attachments/store.js";
import type { SqliteWriter } from "../db/write-worker.js";

import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { isRetired } from "../ws/chat-lifecycle.js";

/**
 * Per-session composer drafts stored on the host (#979, D52 §5–6).
 *
 * Drafts are unsent operational state in the UI's own database: never
 * canonical Markdown, never `brain.db`. The namespace is the host's, shared by
 * every principal that can authenticate to it; each operation re-resolves the
 * calling principal inside its write transaction, so a credential revoked
 * while a request body was in flight commits nothing.
 *
 * Every mutation is one immediate transaction: its checks and its writes see
 * the same state, and a refused or failed request leaves the committed draft
 * exactly as it was. Revisions only grow. Deleting or sending leaves a
 * tombstone row, so nothing stale (a save, a delete, a late acceptance) can
 * bring a removed revision back.
 */

export type DraftImageType = (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number];

/** A refusal with its HTTP status and typed body. */
export class DraftError extends Error {
  readonly bodyJson: string;
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 428 | 507, readonly body: DraftErrorResponse | AttachmentErrorResponse) {
    super(body.message);
    this.name = "DraftError";
    this.bodyJson = JSON.stringify(body);
  }
}

/** The calling principal is no longer usable (revoked, expired or gone). */
export class DraftAuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "DraftAuthError";
  }
}

/** A stored upload not named by any save is removed this long after upload. */
const PENDING_ATTACHMENT_TTL_MS = 60 * 60 * 1_000;
/** Most stored attachments per draft, listed and not yet listed together. */
const MAX_STORED_ATTACHMENTS_PER_DRAFT = MAX_IMAGES_PER_MESSAGE * 2;
/** Receipts kept per draft and operation; older keys are forgotten. */
const RECEIPTS_PER_DRAFT = 32;
/** Accepted-send records kept per draft. */
const SENDS_PER_DRAFT = 8;

interface SaveDraftInput {
  /** The `If-Match` revision; 0 creates the draft. */
  ifMatch: number;
  idempotencyKey: string;
  sessionId: string | null;
  text: string;
  attachmentIds: string[];
  /** File originals this revision binds (#3153). Absent binds none. */
  fileIds?: string[];
  /** The single-slot write (#3153): create or dispatch its snapshot, or remove the one `outgoing` shows (null). */
  outgoing?: DraftOutgoing | null;
  /** The whole outgoing snapshot list (#3588). Absent keeps it. Not combined with `outgoing`. */
  snapshots?: DraftSnapshotWrite[];
}

interface ReserveAttachmentInput {
  /** The declared length, or the per-file maximum when none was declared. */
  bytes: number;
  /** This server process; reservations of another instance are discarded at boot. */
  instanceId: string;
}

interface CommitAttachmentInput {
  reservationId: string;
  idempotencyKey: string;
  /** sha256(draftId, nameHint, mediaHint, bytes), computed by the route. */
  fingerprint: string;
  file: NewAttachment;
}

/** A committed upload, or the earlier file the same key and request stored. */
interface CommitAttachmentResult { file: AttachmentFile; replay: boolean }

interface UploadDraftAttachmentInput {
  idempotencyKey: string;
  mime: DraftImageType;
  name: string | null;
  bytes: Uint8Array;
}

interface AcceptDraftInput {
  draftRef: DraftRef;
  /** The session the accepted message runs in. */
  sessionId: string;
  /** True when the message named an existing session; false for a new conversation. */
  resumed: boolean;
  /** Host-authorized provisional chat adoption; never supplied by a draft-save caller. */
  sourceSessionId?: string;
  requestId?: string;
  principalId: string;
  /**
   * Composer originals the accepted message named (#3153). Each gets a
   * `message` reference for the session, in the same transaction and before
   * the draft revision is consumed.
   */
  fileIds?: string[];
}

/** What an accepted chat message did to the draft it named. */
type DraftAcceptOutcome = "consumed" | "kept" | "unauthorized";

export interface DraftStore {
  readonly limits: Readonly<SessionDraftLimits>;
  list(principalId: string): DraftListResponse;
  get(principalId: string, draftId: string): Draft;
  save(principalId: string, draftId: string, input: SaveDraftInput): DraftSaveResponse;
  upload(principalId: string, draftId: string, input: UploadDraftAttachmentInput): DraftAttachmentResponse;
  remove(principalId: string, draftId: string, ifMatch: number): void;
  bind(principalId: string, draftId: string, input: { sessionId: string; requestId: string }): DraftBindResponse;
  /**
   * Settle the draft a chat message named, at the moment the host accepted
   * that message. Consumes the draft only when the named revision is still
   * current and the draft belongs to the message's session (unbound, for a
   * new conversation); otherwise it stays. A new conversation's acceptance is
   * also recorded, so `bind` can later attach newer edits to that session.
   */
  accept(input: AcceptDraftInput): DraftAcceptOutcome;

  // --- Composer originals (#3153) ---
  /** Reserve pool room for one upload before its bytes are streamed. */
  reserveAttachment(principalId: string, draftId: string, input: ReserveAttachmentInput): { reservationId: string };
  /** Record a published original against its reservation, or replay the key's earlier file. */
  commitAttachment(principalId: string, draftId: string, input: CommitAttachmentInput): CommitAttachmentResult;
  releaseReservation(reservationId: string): void;
  /** Boot: drop reservations another server instance left behind. */
  discardReservations(instanceId: string): void;
  /** Sweep step 1: mark eligible unreferenced files `deleting` and return them. */
  sweepMark(): Array<{ fileId: string; state: "deleting" | "missing" }>;
  /** Sweep step 2: forget files whose directories are gone. */
  sweepForget(fileIds: string[]): void;
  /** Boot: rows whose directory is gone become `missing`. */
  markMissing(fileIds: string[]): void;
  /** Boot: adopt a directory with no row as formerly referenced, charged, with a fresh seven-day clock. */
  adoptOrphan(file: NewAttachment): void;
  /** Remove a deleted chat's `message` references, starting their seven-day clocks, and its read records. */
  releaseSession(sessionId: string): void;
  /** Record one `read_attachment` call (#3154): UI and internal data, never provider context. */
  recordAttachmentRead(read: import("../attachments/store.js").AttachmentReadRecord): void;
  /** Read side: one session's recorded attachment reads, oldest first. */
  attachmentReads(sessionId: string): Array<import("../attachments/store.js").AttachmentReadRecord & { at: number }>;
  /** Read side: recorded originals by id (any state). */
  attachments(fileIds: readonly string[]): Map<string, import("../attachments/store.js").AttachmentRow>;
  /** Read side: whether `fileId` has a reference of this owner. */
  attachmentRef(fileId: string, owner: import("../attachments/store.js").AttachmentOwner, ownerId: string): boolean;
  /** Read side: whether any reference protects `fileId`. */
  attachmentReferenced(fileId: string): boolean;
  /** Read side: every recorded file id and state, for boot reconciliation. */
  attachmentInventory(): Array<{ fileId: string; state: string }>;
  /** The configured attachment pool, in bytes. */
  readonly attachmentPoolBytes: number;
}

interface DraftRow {
  draft_id: string;
  session_id: string | null;
  revision: number;
  text: string;
  attachment_ids: string;
  file_ids: string;
  outgoing_snapshots: string;
  updated_at: number;
  deleted_at: number | null;
}

interface AttachmentRow {
  attachment_id: string;
  mime: DraftImageType;
  name: string | null;
  bytes: Uint8Array;
  size_bytes: number;
  attached: 0 | 1;
}

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function sha256(...parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? encoder.encode(part) : part);
    hash.update(new Uint8Array([0]));
  }
  return hash.digest("hex");
}

/** The first non-empty line, at most DRAFT_PREVIEW_CHARS code points. */
export function draftPreview(text: string): string {
  const line = text.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return Array.from(line).slice(0, DRAFT_PREVIEW_CHARS).join("");
}

/** True when `bytes` starts with the signature of the declared image type. */
export function hasImageSignature(mime: DraftImageType, bytes: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  switch (mime) {
    case "image/jpeg": return bytes.length >= 3 && starts([0xff, 0xd8, 0xff]);
    case "image/png": return bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif": return bytes.length >= 6 && (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    case "image/webp": return bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  }
}

function invalid(message: string): DraftError {
  return new DraftError(400, { error: "DRAFT_INVALID", message });
}

function notFound(): DraftError {
  return new DraftError(404, { error: "DRAFT_NOT_FOUND", message: "No draft with this id is stored on this host." });
}

function deleted(row: DraftRow): DraftError {
  return new DraftError(410, {
    error: "DRAFT_DELETED",
    message: "This draft was deleted or sent. Save the content as a new draft.",
    tombstoneRevision: row.revision,
  });
}

export type DraftWrite = "save" | "upload" | "remove" | "bind" | "accept" | "reserveAttachment" | "commitAttachment" | "releaseReservation"
  | "discardReservations" | "sweepMark" | "sweepForget" | "markMissing" | "adoptOrphan" | "releaseSession" | "recordAttachmentRead";
export type AwaitableDraftStore = Omit<DraftStore, DraftWrite> & {
  [K in DraftWrite]: (...args: Parameters<DraftStore[K]>) => ReturnType<DraftStore[K]> | Promise<ReturnType<DraftStore[K]>>;
} & { settled?(): Promise<void> };
export interface DraftStoreOptions {
  now?: () => number;
  limits?: Partial<SessionDraftLimits>;
  /** The host attachment pool (`BRAIN_UI_ATTACHMENT_POOL_BYTES`); defaults to 1 GiB. */
  attachmentPoolBytes?: number;
}

export function createDraftStore(db: Database, options?: DraftStoreOptions): DraftStore;
export function createDraftStore(db: Database, options: DraftStoreOptions, writer: SqliteWriter): AwaitableDraftStore;
export function createDraftStore(
  db: Database,
  options: DraftStoreOptions = {},
  writer?: SqliteWriter
): AwaitableDraftStore {
  if (writer) return createDraftWrites(db, options, writer);
  const now = options.now ?? Date.now;
  const limits: Readonly<SessionDraftLimits> = Object.freeze({ ...SESSION_DRAFT_LIMITS, ...options.limits });
  const poolBytes = options.attachmentPoolBytes ?? ATTACHMENT_POOL_DEFAULT_BYTES;
  const maxFiles = limits.maxDraftFiles ?? ATTACHMENT_MAX_FILES;
  const maxFileBytes = limits.maxDraftFileBytes ?? ATTACHMENT_MAX_FILE_BYTES;
  const maxFilesBytes = limits.maxDraftFilesBytes ?? ATTACHMENT_MAX_TOTAL_BYTES;

  const maxSnapshots = limits.maxOutgoingSnapshots ?? SESSION_DRAFT_LIMITS.maxOutgoingSnapshots ?? 10;
  const selectDraft = db.prepare(
    "SELECT draft_id, session_id, revision, text, attachment_ids, file_ids, outgoing_snapshots, updated_at, deleted_at FROM session_drafts WHERE draft_id = ?"
  );
  const selectAttachments = db.prepare(
    "SELECT attachment_id, mime, name, bytes, size_bytes, attached FROM session_draft_attachments WHERE draft_id = ?"
  );

  /** A draft bound to a deleted chat (#3230) is never read, extended or rebound. */
  const retired = (sessionId: string | null | undefined) => !!sessionId && isRetired(db, "session", sessionId);
  function refuseRetired(sessionId: string | null | undefined): void {
    if (retired(sessionId)) throw new DraftError(410, { error: "DRAFT_CHAT_RETIRED", message: "This draft's chat was deleted. Nothing was stored." });
  }

  function readDraft(draftId: string): DraftRow | null {
    return selectDraft.get(draftId) as DraftRow | null;
  }

  /** Re-resolve the caller against current principal state. */
  function authorize(principalId: string): void {
    const current = resolvePrincipal(db, principalId);
    if (!current || !isUsablePrincipal(current, now())) throw new DraftAuthError();
  }

  function attachmentIdsOf(row: DraftRow): string[] {
    return JSON.parse(row.attachment_ids) as string[];
  }

  function fileIdsOf(row: DraftRow): string[] {
    return JSON.parse(row.file_ids) as string[];
  }

  function snapshotsOf(row: DraftRow): DraftSnapshot[] {
    return JSON.parse(row.outgoing_snapshots) as DraftSnapshot[];
  }

  /** The single-slot view: the newest snapshot still held or unconfirmed. */
  function legacyOutgoing(snapshots: readonly DraftSnapshot[]): DraftSnapshot | null {
    for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i]!.state !== "returned") return snapshots[i]!;
    return null;
  }

  /** Every file a draft's snapshots own, once each. */
  function snapshotFiles(snapshots: readonly DraftSnapshotWrite[]): string[] {
    return [...new Set(snapshots.flatMap((s) => s.fileIds))];
  }

  /**
   * Live snapshots of the chat a draft belongs to, outside that draft: every
   * other live draft bound to the same session, whichever tab or device saved
   * it. A draft with no session yet is a chat of its own.
   */
  function otherChatSnapshots(draftId: string, sessionId: string | null): number {
    if (sessionId === null) return 0;
    const row = db.query(
      "SELECT COALESCE(SUM(json_array_length(outgoing_snapshots)), 0) AS n FROM session_drafts WHERE session_id = ? AND draft_id != ? AND deleted_at IS NULL"
    ).get(sessionId, draftId) as { n: number };
    return row.n;
  }

  function outgoingInvalid(message: string): DraftError {
    return invalid(message);
  }

  /**
   * The list a save leaves, from the stored list and what the request names.
   * Edits happen in place and never need a free slot; `created` lists the new
   * snapshots, which the caller counts against the chat's capacity.
   */
  function nextSnapshots(stored: readonly DraftSnapshot[], input: SaveDraftInput, at: number): { list: DraftSnapshot[]; created: DraftSnapshot[] } {
    if (input.snapshots !== undefined && input.outgoing !== undefined) throw outgoingInvalid("Send either outgoing or snapshots, not both.");
    if (input.snapshots === undefined && input.outgoing === undefined) return { list: [...stored], created: [] };
    const byId = new Map(stored.map((s) => [s.snapshotId, s]));
    if (input.outgoing === null) {
      // The single-slot clear removes the snapshot that slot shows, as #3153 did.
      const shown = legacyOutgoing(stored);
      return { list: stored.filter((s) => s !== shown), created: [] };
    }
    const writes: DraftSnapshotWrite[] = input.outgoing !== undefined
      ? (() => {
        // The single-slot write addresses the snapshot of its request.
        const o = input.outgoing;
        const existing = stored.find((s) => s.requestId === o.requestId);
        const write = { snapshotId: existing?.snapshotId ?? o.requestId, requestId: o.requestId, text: o.text, fileIds: o.fileIds, state: o.state };
        return existing ? stored.map((s) => (s === existing ? write : s)) : [...stored, write];
      })()
      : input.snapshots!;
    const seen = new Set<string>();
    const requests = new Set<string>();
    const list: DraftSnapshot[] = [];
    const created: DraftSnapshot[] = [];
    for (const write of writes) {
      if (seen.has(write.snapshotId)) throw outgoingInvalid("A snapshot is listed twice.");
      if (requests.has(write.requestId)) throw outgoingInvalid("Two snapshots name the same requestId.");
      seen.add(write.snapshotId); requests.add(write.requestId);
      const prior = byId.get(write.snapshotId);
      if (!prior) {
        if (write.state === "returned") throw outgoingInvalid("A new snapshot is held or dispatched.");
        if (stored.some((s) => s.requestId === write.requestId)) throw outgoingInvalid("Another snapshot already sends this requestId.");
        const snapshot = { ...write, fileIds: [...write.fileIds], createdAt: at };
        list.push(snapshot); created.push(snapshot);
        continue;
      }
      // Nothing of a snapshot changes but its state, and a held one's files.
      if (write.requestId !== prior.requestId || write.text !== prior.text) throw outgoingInvalid("A snapshot's text and requestId do not change.");
      const sameFiles = write.fileIds.length === prior.fileIds.length && write.fileIds.every((id, i) => id === prior.fileIds[i]);
      if (!sameFiles && prior.state !== "held") throw outgoingInvalid("Only a held snapshot's files change.");
      const allowed = write.state === prior.state
        || (prior.state === "held" && (write.state === "returned" || write.state === "dispatched"))
        || (prior.state === "dispatched" && write.state === "returned");
      if (!allowed) throw outgoingInvalid(`A ${prior.state} snapshot cannot become ${write.state}.`);
      list.push({ ...prior, fileIds: [...write.fileIds], state: write.state });
    }
    // Leaving a snapshot out deletes it, which only a returned one may be.
    for (const prior of stored) {
      if (!seen.has(prior.snapshotId) && prior.state !== "returned") {
        throw outgoingInvalid(`A ${prior.state} snapshot is not deleted; return it first.`);
      }
    }
    return { list, created };
  }

  function toDraft(row: DraftRow): Draft {
    const stored = new Map(
      (selectAttachments.all(row.draft_id) as AttachmentRow[]).map((a) => [a.attachment_id, a])
    );
    const fileIds = fileIdsOf(row);
    const snapshots = snapshotsOf(row);
    const shown = legacyOutgoing(snapshots);
    const outgoing: DraftOutgoing | null = shown
      ? { requestId: shown.requestId, text: shown.text, fileIds: shown.fileIds, state: shown.state as DraftOutgoing["state"] }
      : null;
    const files = readAttachments(db, fileIds);
    return {
      // Only files the revision still binds and that exist: a saved claim is never invented.
      ...(fileIds.length ? { files: fileIds.flatMap((id) => { const f = files.get(id); return f && f.state === "stored" ? [toAttachmentFile(f)] : []; }) } : {}),
      ...(outgoing ? { outgoing } : {}),
      ...(snapshots.length ? { snapshots } : {}),
      draftId: row.draft_id,
      sessionId: row.session_id,
      revision: row.revision,
      updatedAt: row.updated_at,
      text: row.text,
      attachments: attachmentIdsOf(row).flatMap((id) => {
        const a = stored.get(id);
        return a ? [{ attachmentId: id, mime: a.mime, bytes: Buffer.from(a.bytes).toString("base64"), name: a.name }] : [];
      }),
    };
  }

  function conflict(row: DraftRow): DraftError {
    // A conflict carries the current content: never for a deleted chat's draft.
    if (retired(row.session_id)) return new DraftError(410, { error: "DRAFT_CHAT_RETIRED", message: "This draft's chat was deleted. Nothing was stored." });
    return new DraftError(409, {
      error: "DRAFT_CONFLICT",
      message: "This draft changed on another device.",
      current: toDraft(row),
    });
  }

  function sweepPending(at: number): void {
    db.prepare("DELETE FROM session_draft_attachments WHERE attached = 0 AND created_at < ?").run(at - PENDING_ATTACHMENT_TTL_MS);
  }

  function totalBytes(): number {
    const row = db.query(
      `SELECT
         (SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM session_drafts WHERE deleted_at IS NULL)
       + (SELECT COALESCE(SUM(size_bytes), 0) FROM session_draft_attachments) AS total`
    ).get() as { total: number };
    return row.total + draftReferencedBytes(db);
  }

  function poolFull(limit = poolBytes): DraftError {
    return new DraftError(507, { error: "ATTACHMENT_CAPACITY", message: "This host's attachment space is full. Nothing was removed to make room.", limit, bound: "pool" });
  }

  function attachmentInvalid(message: string): DraftError {
    return new DraftError(400, { error: "ATTACHMENT_INVALID", message });
  }

  /**
   * Check a list of file ids a save names: each exists, is `stored`, was
   * minted for this draft (its lineage) and is listed once; the list fits the
   * per-draft envelope together with `imageCount` legacy images of
   * `imageBytes`. Returns the files' original bytes.
   */
  function checkFiles(draftId: string, fileIds: readonly string[], imageCount: number, imageBytes: number): number {
    if (new Set(fileIds).size !== fileIds.length) throw attachmentInvalid("A file is listed twice.");
    if (fileIds.length + imageCount > maxFiles) {
      throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: `Up to ${maxFiles} attachments per message.`, limit: maxFiles, bound: "draftCount" });
    }
    const rows = readAttachments(db, fileIds);
    let bytes = 0;
    for (const id of fileIds) {
      const file = rows.get(id);
      if (!file || file.draft_id !== draftId) throw attachmentInvalid("A file is not stored for this draft; upload it again.");
      if (file.state !== "stored") throw attachmentInvalid("A file is no longer available; upload it again.");
      bytes += file.bytes;
    }
    if (bytes + imageBytes > maxFilesBytes) {
      throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "These attachments are too large together.", limit: maxFilesBytes, bound: "draftFiles" });
    }
    return bytes;
  }

  /** Bytes of distinct files that would newly count against the draft sub-limit. */
  function newlyReferencedBytes(fileIds: readonly string[], draftId: string): number {
    let bytes = 0;
    for (const [id, file] of readAttachments(db, [...new Set(fileIds)])) {
      const held = db.query("SELECT 1 FROM attachment_refs WHERE file_id = ? AND owner IN ('draft', 'outgoing') AND owner_id = ?").get(id, draftId);
      if (!held && !db.query("SELECT 1 FROM attachment_refs WHERE file_id = ? AND owner IN ('draft', 'outgoing')").get(id)) bytes += file.bytes;
    }
    return bytes;
  }

  function receipt(draftId: string, operation: "save" | "attachment", key: string, fingerprint: string): unknown | undefined {
    const row = db
      .query("SELECT fingerprint, response_json FROM session_draft_receipts WHERE draft_id = ? AND operation = ? AND idempotency_key = ?")
      .get(draftId, operation, key) as { fingerprint: string; response_json: string } | null;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) {
      throw new DraftError(409, { error: "DRAFT_KEY_REUSED", message: "This Idempotency-Key was used for a different request." });
    }
    return JSON.parse(row.response_json);
  }

  function recordReceipt(draftId: string, operation: "save" | "attachment", key: string, fingerprint: string, response: unknown, principalId: string, at: number): void {
    db.prepare(
      "INSERT INTO session_draft_receipts (draft_id, operation, idempotency_key, fingerprint, response_json, created_at, principal_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(draftId, operation, key, fingerprint, JSON.stringify(response), at, principalId);
    db.prepare(
      `DELETE FROM session_draft_receipts WHERE draft_id = ?1 AND operation = ?2 AND idempotency_key NOT IN (
         SELECT idempotency_key FROM session_draft_receipts WHERE draft_id = ?1 AND operation = ?2
         ORDER BY created_at DESC, rowid DESC LIMIT ${RECEIPTS_PER_DRAFT})`
    ).run(draftId, operation);
  }

  /** Turn a live draft into a tombstone at the next revision. */
  function tombstone(row: DraftRow, reason: "deleted" | "sent", principalId: string, at: number): void {
    db.prepare(
      `UPDATE session_drafts SET revision = ?, text = '', attachment_ids = '[]', size_bytes = 0,
         updated_at = ?, updated_by = ?, deleted_at = ?, deleted_reason = ? WHERE draft_id = ?`
    ).run(row.revision + 1, at, principalId, at, reason, row.draft_id);
    db.prepare("DELETE FROM session_draft_attachments WHERE draft_id = ?").run(row.draft_id);
    // The draft's own bindings go; a message reference written by an
    // acceptance keeps protecting what was sent.
    setRefs(db, "draft", row.draft_id, [], at);
    setRefs(db, "outgoing", row.draft_id, [], at);
    db.prepare("UPDATE session_drafts SET file_ids = '[]', outgoing_snapshots = '[]' WHERE draft_id = ?").run(row.draft_id);
  }

  return {
    limits,
    attachmentPoolBytes: poolBytes,

    list(principalId) {
      return db.transaction(() => {
        authorize(principalId);
        const rows = db.query(
          `SELECT draft_id, session_id, revision, text, attachment_ids, file_ids, outgoing_snapshots, updated_at, deleted_at FROM session_drafts
           WHERE deleted_at IS NULL AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM chat_retired_identities WHERE kind = 'session'))
           ORDER BY updated_at DESC, draft_id ASC LIMIT ?`
        ).all(limits.maxDrafts) as DraftRow[];
        const drafts: DraftSummary[] = rows.map((row) => ({
          draftId: row.draft_id,
          sessionId: row.session_id,
          revision: row.revision,
          updatedAt: row.updated_at,
          preview: draftPreview(row.text),
          attachmentCount: attachmentIdsOf(row).length,
          ...(fileIdsOf(row).length ? { fileCount: fileIdsOf(row).length } : {}),
        }));
        return { drafts };
      })();
    },

    get(principalId, draftId) {
      return db.transaction(() => {
        authorize(principalId);
        const row = readDraft(draftId);
        if (!row || retired(row.session_id)) throw notFound();
        if (row.deleted_at !== null) throw deleted(row);
        return toDraft(row);
      })();
    },

    save(principalId, draftId, input) {
      return db.transaction((): DraftSaveResponse => {
        const at = now();
        authorize(principalId);
        sweepPending(at);
        refuseRetired(input.sessionId);
        const fileIds = input.fileIds ?? [];
        // Older requests keep their exact fingerprint; file fields join it only when sent.
        const fingerprint = sha256("save", String(input.ifMatch), JSON.stringify(
          input.fileIds === undefined && input.outgoing === undefined && input.snapshots === undefined
            ? [input.sessionId, input.text, input.attachmentIds]
            : input.snapshots === undefined
              ? [input.sessionId, input.text, input.attachmentIds, fileIds, input.outgoing ?? null, input.outgoing === undefined]
              : [input.sessionId, input.text, input.attachmentIds, fileIds, "snapshots", input.snapshots]));
        const replay = receipt(draftId, "save", input.idempotencyKey, fingerprint);
        if (replay !== undefined) return replay as DraftSaveResponse;

        const row = readDraft(draftId);
        if (row?.deleted_at != null) throw deleted(row);
        if (!row && input.ifMatch !== 0) throw notFound();
        if (row && input.ifMatch !== row.revision) throw conflict(row);
        // Binding is its own proven operation; a save cannot move a draft.
        if (row && input.sessionId !== row.session_id) throw conflict(row);

        const { list: snapshots, created } = nextSnapshots(row ? snapshotsOf(row) : [], input, at);
        if (input.text.length === 0 && input.attachmentIds.length === 0 && fileIds.length === 0 && snapshots.length === 0) {
          throw invalid("An empty draft is deleted, not saved.");
        }
        const textBytes = utf8Bytes(input.text);
        if (textBytes > limits.maxTextBytes) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "Draft text is too large.", limit: limits.maxTextBytes, bound: "text" });
        }
        if (new Set(input.attachmentIds).size !== input.attachmentIds.length) throw invalid("An attachment is listed twice.");
        if (input.attachmentIds.length > MAX_IMAGES_PER_MESSAGE) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "Too many images.", limit: MAX_IMAGES_PER_MESSAGE, bound: "imageCount" });
        }
        const stored = new Map(
          (selectAttachments.all(draftId) as AttachmentRow[]).map((a) => [a.attachment_id, a])
        );
        let imageBytes = 0;
        for (const id of input.attachmentIds) {
          const attachment = stored.get(id);
          if (!attachment) throw invalid("An attachment is not stored for this draft; upload it again.");
          imageBytes += attachment.size_bytes;
        }
        if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "The images are too large together.", limit: MAX_TOTAL_IMAGE_BYTES, bound: "images" });
        }
        if (textBytes + imageBytes > limits.maxDraftBytes) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "This draft is too large.", limit: limits.maxDraftBytes, bound: "draft" });
        }
        // File originals have their own envelope; the old draft ceiling bounds only text and inline images.
        checkFiles(draftId, fileIds, input.attachmentIds.length, imageBytes);
        // Each snapshot is its own message: new ones, and a held one whose files changed, meet its envelope.
        const priorSnapshots = new Map((row ? snapshotsOf(row) : []).map((s) => [s.snapshotId, s]));
        for (const snapshot of snapshots) {
          const prior = priorSnapshots.get(snapshot.snapshotId);
          if (prior && prior.fileIds.join() === snapshot.fileIds.join()) continue;
          if (!prior && utf8Bytes(snapshot.text) > limits.maxTextBytes) {
            throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "Draft text is too large.", limit: limits.maxTextBytes, bound: "text" });
          }
          checkFiles(draftId, snapshot.fileIds, 0, 0);
        }
        // The save that creates a snapshot is its reservation: it counts every
        // live snapshot of the chat, across drafts, tabs and devices, inside
        // this immediate transaction. Edits in place are never refused here.
        if (created.length > 0 && otherChatSnapshots(draftId, input.sessionId) + snapshots.length > maxSnapshots) {
          throw new DraftError(409, {
            error: "DRAFT_OUTGOING_FULL",
            message: `${maxSnapshots} messages in this chat are waiting or need recovery. Nothing was sent.`,
            limit: maxSnapshots,
          });
        }
        if (!row) {
          const live = (db.query("SELECT COUNT(*) AS n FROM session_drafts WHERE deleted_at IS NULL").get() as { n: number }).n;
          if (live >= limits.maxDrafts) {
            throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host holds the most drafts it keeps.", limit: limits.maxDrafts, bound: "drafts" });
          }
        }
        // The host total after this save: its text replaces the old text, and
        // the images the old revision listed but this one drops are deleted.
        const previousTextBytes = row ? utf8Bytes(row.text) : 0;
        const keep = new Set(input.attachmentIds);
        let droppedBytes = 0;
        for (const attachment of stored.values()) {
          if (attachment.attached === 1 && !keep.has(attachment.attachment_id)) droppedBytes += attachment.size_bytes;
        }
        // Files are charged to the draft sub-limit once, by whichever live
        // draft or snapshot references them; only newly bound ones grow it.
        const growth = textBytes - previousTextBytes - droppedBytes
          + newlyReferencedBytes([...fileIds, ...snapshotFiles(snapshots)], draftId);
        if (growth > 0 && totalBytes() + growth > limits.maxTotalBytes) {
          throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host's draft storage is full.", limit: limits.maxTotalBytes, bound: "total" });
        }

        const revision = (row?.revision ?? 0) + 1;
        const ids = JSON.stringify(input.attachmentIds);
        if (row) {
          db.prepare(
            "UPDATE session_drafts SET revision = ?, text = ?, attachment_ids = ?, file_ids = ?, outgoing_snapshots = ?, size_bytes = ?, updated_at = ?, updated_by = ? WHERE draft_id = ?"
          ).run(revision, input.text, ids, JSON.stringify(fileIds), JSON.stringify(snapshots), textBytes + imageBytes, at, principalId, draftId);
        } else {
          db.prepare(
            `INSERT INTO session_drafts (draft_id, session_id, revision, text, attachment_ids, file_ids, outgoing_snapshots, size_bytes, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(draftId, input.sessionId, revision, input.text, ids, JSON.stringify(fileIds), JSON.stringify(snapshots), textBytes + imageBytes, at, principalId, at, principalId);
        }
        // Exactly this revision's bindings; the snapshots own theirs together.
        // Insert before removal so a file moving between them never looks
        // unreferenced. A deleted snapshot's files start their seven-day clock.
        const owned = snapshotFiles(snapshots);
        for (const id of owned) addRef(db, id, "outgoing", draftId, at);
        setRefs(db, "draft", draftId, fileIds, at);
        setRefs(db, "outgoing", draftId, owned, at);
        // An image the previous revision listed and this one dropped is gone;
        // an upload no revision has listed yet waits for its own save.
        for (const attachment of stored.values()) {
          if (keep.has(attachment.attachment_id)) {
            db.prepare("UPDATE session_draft_attachments SET attached = 1 WHERE attachment_id = ?").run(attachment.attachment_id);
          } else {
            db.prepare("DELETE FROM session_draft_attachments WHERE attachment_id = ? AND attached = 1").run(attachment.attachment_id);
          }
        }
        const response: DraftSaveResponse = { revision, updatedAt: at };
        recordReceipt(draftId, "save", input.idempotencyKey, fingerprint, response, principalId, at);
        return response;
      }).immediate();
    },

    upload(principalId, draftId, input) {
      return db.transaction((): DraftAttachmentResponse => {
        const at = now();
        authorize(principalId);
        sweepPending(at);
        refuseRetired(readDraft(draftId)?.session_id);
        const fingerprint = sha256("attachment", input.mime, input.name ?? "", input.bytes);
        const replay = receipt(draftId, "attachment", input.idempotencyKey, fingerprint) as DraftAttachmentResponse | undefined;
        if (replay !== undefined) {
          const kept = db.query("SELECT 1 FROM session_draft_attachments WHERE attachment_id = ?").get(replay.attachmentId);
          if (kept) return replay;
          // The bytes are gone (swept, dropped or deleted): a receipt for them
          // would acknowledge an id no save can use. Store the upload afresh.
          db.prepare("DELETE FROM session_draft_receipts WHERE draft_id = ? AND operation = 'attachment' AND idempotency_key = ?")
            .run(draftId, input.idempotencyKey);
        }

        const row = readDraft(draftId);
        if (row?.deleted_at != null) throw deleted(row);
        if (input.bytes.byteLength === 0) throw invalid("The image is empty.");
        if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "This image is too large.", limit: MAX_IMAGE_BYTES, bound: "image" });
        }
        if (!hasImageSignature(input.mime, input.bytes)) throw invalid(`The bytes are not a ${input.mime} image.`);
        const count = (db.query("SELECT COUNT(*) AS n FROM session_draft_attachments WHERE draft_id = ?").get(draftId) as { n: number }).n;
        if (count >= MAX_STORED_ATTACHMENTS_PER_DRAFT) {
          throw new DraftError(413, { error: "DRAFT_TOO_LARGE", message: "This draft holds the most images it can.", limit: MAX_STORED_ATTACHMENTS_PER_DRAFT, bound: "imageCount" });
        }
        if (totalBytes() + input.bytes.byteLength > limits.maxTotalBytes) {
          throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host's draft storage is full.", limit: limits.maxTotalBytes, bound: "total" });
        }
        // Legacy draft images are charged to the attachment pool too.
        if (poolCharged(db) + input.bytes.byteLength > poolBytes) {
          throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host's attachment space is full.", limit: poolBytes, bound: "total" });
        }
        const attachmentId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO session_draft_attachments (attachment_id, draft_id, mime, name, bytes, size_bytes, attached, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(attachmentId, draftId, input.mime, input.name, input.bytes, input.bytes.byteLength, at, principalId);
        const response: DraftAttachmentResponse = { attachmentId };
        recordReceipt(draftId, "attachment", input.idempotencyKey, fingerprint, response, principalId, at);
        return response;
      }).immediate();
    },

    remove(principalId, draftId, ifMatch) {
      db.transaction(() => {
        const at = now();
        authorize(principalId);
        const row = readDraft(draftId);
        if (!row) throw notFound();
        if (row.deleted_at !== null) {
          // The same delete, retried after its acknowledgement was lost.
          if (ifMatch === row.revision - 1) return;
          throw deleted(row);
        }
        if (ifMatch !== row.revision) throw conflict(row);
        // Deleting the draft deletes its returned snapshots; a held or
        // unconfirmed one is never dropped this way.
        if (snapshotsOf(row).some((s) => s.state !== "returned")) {
          throw new DraftError(409, {
            error: "DRAFT_OUTGOING_PENDING",
            message: "A message of this draft is still waiting or unconfirmed. Cancel it or check it first.",
            current: toDraft(row),
          });
        }
        tombstone(row, "deleted", principalId, at);
      }).immediate();
    },

    bind(principalId, draftId, input) {
      return db.transaction((): DraftBindResponse => {
        const at = now();
        authorize(principalId);
        refuseRetired(input.sessionId);
        const send = db
          .query("SELECT session_id FROM session_draft_sends WHERE draft_id = ? AND request_id = ?")
          .get(draftId, input.requestId) as { session_id: string } | null;
        if (!send || send.session_id !== input.sessionId) {
          throw new DraftError(409, {
            error: "DRAFT_NOT_ACCEPTED",
            message: "No accepted message started this session from this draft and request.",
          });
        }
        const row = readDraft(draftId);
        if (!row) throw notFound();
        if (row.deleted_at !== null) throw deleted(row);
        if (row.session_id === input.sessionId) return { revision: row.revision };
        if (row.session_id !== null) throw conflict(row);
        const revision = row.revision + 1;
        db.prepare("UPDATE session_drafts SET session_id = ?, revision = ?, updated_at = ?, updated_by = ? WHERE draft_id = ?")
          .run(input.sessionId, revision, at, principalId, draftId);
        return { revision };
      }).immediate();
    },

    accept(input) {
      return db.transaction((): DraftAcceptOutcome => {
        const at = now();
        try { authorize(input.principalId); }
        catch (error) { if (error instanceof DraftAuthError) return "unauthorized"; throw error; }
        const { draftId, revision } = input.draftRef;
        // The message reference is written before anything of the draft goes,
        // so an accepted send never leaves its originals unprotected. Lineage
        // limits it to files minted for this draft.
        for (const [id, file] of readAttachments(db, [...new Set(input.fileIds ?? [])])) {
          if (file.draft_id === draftId && file.state === "stored") addRef(db, id, "message", input.sessionId, at);
        }
        // Only the accepted request's snapshot is released; the others stay.
        const settled = readDraft(draftId);
        const kept = settled && input.requestId ? snapshotsOf(settled).filter((s) => s.requestId !== input.requestId) : null;
        if (settled && kept && kept.length !== snapshotsOf(settled).length) {
          setRefs(db, "outgoing", draftId, snapshotFiles(kept), at);
          db.prepare("UPDATE session_drafts SET outgoing_snapshots = ? WHERE draft_id = ?").run(JSON.stringify(kept), draftId);
        }
        if (!input.resumed && input.requestId) {
          db.prepare(
            `INSERT OR IGNORE INTO session_draft_sends (draft_id, request_id, session_id, revision, principal_id, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(draftId, input.requestId, input.sessionId, revision, input.principalId, at);
          db.prepare(
            `DELETE FROM session_draft_sends WHERE draft_id = ?1 AND request_id NOT IN (
               SELECT request_id FROM session_draft_sends WHERE draft_id = ?1
               ORDER BY accepted_at DESC, rowid DESC LIMIT ${SENDS_PER_DRAFT})`
          ).run(draftId);
        }
        const row = readDraft(draftId);
        if (!row || row.deleted_at !== null || retired(row.session_id) || retired(input.sessionId)) return "kept";
        const source = input.resumed ? input.sessionId : input.sourceSessionId ?? null;
        if (row.session_id !== source) return "kept";
        if (row.revision !== revision) {
          // Edits made after submission stay with the same chat when its first
          // real task names it. Version the ownership move for concurrent saves.
          if (input.sourceSessionId && !input.resumed && input.requestId)
            db.prepare("UPDATE session_drafts SET session_id=?,revision=?,updated_at=?,updated_by=? WHERE draft_id=?")
              .run(input.sessionId,row.revision+1,at,input.principalId,draftId);
          return "kept";
        }
        const remaining = snapshotsOf(row);
        if (remaining.length > 0) {
          // The sent revision is consumed, but the chat's other snapshots are
          // never evicted with it: the draft stays, at the next revision, with
          // an empty composer and those snapshots.
          setRefs(db, "draft", draftId, [], at);
          db.prepare("DELETE FROM session_draft_attachments WHERE draft_id = ?").run(draftId);
          db.prepare(
            "UPDATE session_drafts SET revision = ?, text = '', attachment_ids = '[]', file_ids = '[]', size_bytes = 0, updated_at = ?, updated_by = ? WHERE draft_id = ?"
          ).run(row.revision + 1, at, input.principalId, draftId);
          return "consumed";
        }
        tombstone(row, "sent", input.principalId, at);
        return "consumed";
      }).immediate();
    },

    reserveAttachment(principalId, draftId, input) {
      return db.transaction((): { reservationId: string } => {
        const at = now();
        authorize(principalId);
        const row = readDraft(draftId);
        if (row?.deleted_at != null) throw deleted(row);
        const envelope = draftEnvelope(db, draftId, at);
        if (envelope.count >= maxFiles) {
          throw new DraftError(413, { error: "ATTACHMENT_TOO_LARGE", message: `Up to ${maxFiles} attachments per message.`, limit: maxFiles, bound: "draftCount" });
        }
        // Checked against what is charged and reserved now, inside one
        // immediate transaction: concurrent uploads cannot multiply the cap.
        if (poolCharged(db) + input.bytes > poolBytes) throw poolFull();
        const reservationId = crypto.randomUUID();
        db.prepare("INSERT INTO attachment_reservations (reservation_id, bytes, instance_id, draft_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(reservationId, input.bytes, input.instanceId, draftId, at);
        return { reservationId };
      }).immediate();
    },

    commitAttachment(principalId, draftId, input) {
      return db.transaction((): CommitAttachmentResult => {
        const at = now();
        authorize(principalId);
        const reservation = db.query("SELECT bytes FROM attachment_reservations WHERE reservation_id = ?").get(input.reservationId) as { bytes: number } | null;
        const release = () => db.prepare("DELETE FROM attachment_reservations WHERE reservation_id = ?").run(input.reservationId);
        const receiptRow = db.query("SELECT fingerprint, file_id FROM attachment_receipts WHERE draft_id = ? AND idempotency_key = ?")
          .get(draftId, input.idempotencyKey) as { fingerprint: string; file_id: string } | null;
        if (receiptRow) {
          if (receiptRow.fingerprint !== input.fingerprint) {
            release();
            throw new DraftError(409, { error: "ATTACHMENT_KEY_REUSED", message: "This Idempotency-Key was used for a different upload." });
          }
          const earlier = readAttachment(db, receiptRow.file_id);
          if (earlier && earlier.state === "stored") { release(); return { file: toAttachmentFile(earlier), replay: true }; }
          // The earlier file is gone: its receipt must not acknowledge it. Store afresh.
          db.prepare("DELETE FROM attachment_receipts WHERE draft_id = ? AND idempotency_key = ?").run(draftId, input.idempotencyKey);
        }
        const row = readDraft(draftId);
        if (row?.deleted_at != null) { release(); throw deleted(row); }
        if (!reservation) throw attachmentInvalid("The upload's reservation is gone; upload it again.");
        if (!FILE_ID.test(input.file.fileId) || input.file.bytes <= 0) { release(); throw attachmentInvalid("The file is empty."); }
        if (input.file.bytes > maxFileBytes) {
          release();
          throw new DraftError(413, { error: "ATTACHMENT_TOO_LARGE", message: "Files can be up to 25 MB each.", limit: maxFileBytes, bound: "file" });
        }
        const envelope = draftEnvelope(db, draftId, at);
        if (envelope.count >= maxFiles) {
          release();
          throw new DraftError(413, { error: "ATTACHMENT_TOO_LARGE", message: `Up to ${maxFiles} attachments per message.`, limit: maxFiles, bound: "draftCount" });
        }
        if (envelope.bytes + input.file.bytes > maxFilesBytes) {
          release();
          throw new DraftError(413, { error: "ATTACHMENT_TOO_LARGE", message: "These attachments are too large together.", limit: maxFilesBytes, bound: "draftFiles" });
        }
        // The real size replaces the reservation; it may be larger than declared.
        if (poolCharged(db) - reservation.bytes + input.file.bytes > poolBytes) { release(); throw poolFull(); }
        release();
        insertAttachment(db, draftId, input.file, principalId, at);
        db.prepare("INSERT INTO attachment_receipts (draft_id, idempotency_key, fingerprint, file_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(draftId, input.idempotencyKey, input.fingerprint, input.file.fileId, at);
        db.prepare(
          `DELETE FROM attachment_receipts WHERE draft_id = ?1 AND idempotency_key NOT IN (
             SELECT idempotency_key FROM attachment_receipts WHERE draft_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ${RECEIPTS_PER_DRAFT})`
        ).run(draftId);
        return { file: toAttachmentFile(readAttachment(db, input.file.fileId)!), replay: false };
      }).immediate();
    },

    releaseReservation(reservationId) {
      db.prepare("DELETE FROM attachment_reservations WHERE reservation_id = ?").run(reservationId);
    },

    discardReservations(instanceId) {
      db.prepare("DELETE FROM attachment_reservations WHERE instance_id <> ?").run(instanceId);
    },

    sweepMark() {
      return db.transaction(() => markForDeletion(db, now())).immediate();
    },

    sweepForget(fileIds) {
      db.transaction(() => forgetDeleted(db, fileIds)).immediate();
    },

    markMissing(fileIds) {
      db.transaction(() => {
        for (const id of fileIds) db.prepare("UPDATE attachment_files SET state = 'missing' WHERE file_id = ? AND state = 'stored'").run(id);
      }).immediate();
    },

    adoptOrphan(file) {
      db.transaction(() => {
        const at = now();
        if (readAttachment(db, file.fileId)) return;
        insertAttachment(db, "", file, "host", at);
        db.prepare("UPDATE attachment_files SET ever_referenced = 1, unreferenced_since = ? WHERE file_id = ?").run(at, file.fileId);
      }).immediate();
    },

    releaseSession(sessionId) {
      db.transaction(() => {
        const at = now();
        const ids = (db.query("SELECT file_id FROM attachment_refs WHERE owner = 'message' AND owner_id = ?").all(sessionId) as { file_id: string }[]).map((r) => r.file_id);
        for (const id of ids) {
          db.prepare("DELETE FROM attachment_refs WHERE file_id = ? AND owner = 'message' AND owner_id = ?").run(id, sessionId);
          if (!hasAnyRef(db, id)) db.prepare("UPDATE attachment_files SET unreferenced_since = ? WHERE file_id = ?").run(at, id);
        }
        db.prepare("DELETE FROM attachment_reads WHERE session_id = ?").run(sessionId);
      }).immediate();
    },

    recordAttachmentRead(read) {
      db.transaction(() => insertAttachmentRead(db, read, now())).immediate();
    },

    attachmentReads(sessionId) {
      return listAttachmentReads(db, sessionId);
    },

    attachments(fileIds) {
      return readAttachments(db, fileIds);
    },

    attachmentRef(fileId, owner, ownerId) {
      return db.query("SELECT 1 FROM attachment_refs WHERE file_id = ? AND owner = ? AND owner_id = ?").get(fileId, owner, ownerId) !== null;
    },

    attachmentReferenced(fileId) {
      return hasAnyRef(db, fileId);
    },

    attachmentInventory() {
      return (db.query("SELECT file_id AS fileId, state FROM attachment_files").all() as Array<{ fileId: string; state: string }>);
    },
  };
}
