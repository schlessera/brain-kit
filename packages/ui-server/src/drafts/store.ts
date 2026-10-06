import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
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

import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";

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
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 428 | 507, readonly body: DraftErrorResponse) {
    super(body.message);
    this.name = "DraftError";
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
export const PENDING_ATTACHMENT_TTL_MS = 60 * 60 * 1_000;
/** Most stored attachments per draft, listed and not yet listed together. */
export const MAX_STORED_ATTACHMENTS_PER_DRAFT = MAX_IMAGES_PER_MESSAGE * 2;
/** Receipts kept per draft and operation; older keys are forgotten. */
const RECEIPTS_PER_DRAFT = 32;
/** Accepted-send records kept per draft. */
const SENDS_PER_DRAFT = 8;

export interface SaveDraftInput {
  /** The `If-Match` revision; 0 creates the draft. */
  ifMatch: number;
  idempotencyKey: string;
  sessionId: string | null;
  text: string;
  attachmentIds: string[];
}

export interface UploadDraftAttachmentInput {
  idempotencyKey: string;
  mime: DraftImageType;
  name: string | null;
  bytes: Uint8Array;
}

export interface AcceptDraftInput {
  draftRef: DraftRef;
  /** The session the accepted message runs in. */
  sessionId: string;
  /** True when the message named an existing session; false for a new conversation. */
  resumed: boolean;
  requestId?: string;
  principalId: string;
}

/** What an accepted chat message did to the draft it named. */
export type DraftAcceptOutcome = "consumed" | "kept" | "unauthorized";

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
}

interface DraftRow {
  draft_id: string;
  session_id: string | null;
  revision: number;
  text: string;
  attachment_ids: string;
  updated_at: number;
  deleted_at: number | null;
}

interface AttachmentRow {
  attachment_id: string;
  mime: DraftImageType;
  name: string | null;
  bytes: Uint8Array;
  size_bytes: number;
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

export function createDraftStore(
  db: Database,
  options: { now?: () => number; limits?: Partial<SessionDraftLimits> } = {}
): DraftStore {
  const now = options.now ?? Date.now;
  const limits: Readonly<SessionDraftLimits> = Object.freeze({ ...SESSION_DRAFT_LIMITS, ...options.limits });

  const selectDraft = db.prepare(
    "SELECT draft_id, session_id, revision, text, attachment_ids, updated_at, deleted_at FROM session_drafts WHERE draft_id = ?"
  );
  const selectAttachments = db.prepare(
    "SELECT attachment_id, mime, name, bytes, size_bytes FROM session_draft_attachments WHERE draft_id = ?"
  );

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

  function toDraft(row: DraftRow): Draft {
    const stored = new Map(
      (selectAttachments.all(row.draft_id) as AttachmentRow[]).map((a) => [a.attachment_id, a])
    );
    return {
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
    return row.total;
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
  }

  return {
    limits,

    list(principalId) {
      return db.transaction(() => {
        authorize(principalId);
        const rows = db.query(
          `SELECT draft_id, session_id, revision, text, attachment_ids, updated_at, deleted_at FROM session_drafts
           WHERE deleted_at IS NULL ORDER BY updated_at DESC, draft_id ASC LIMIT ?`
        ).all(limits.maxDrafts) as DraftRow[];
        const drafts: DraftSummary[] = rows.map((row) => ({
          draftId: row.draft_id,
          sessionId: row.session_id,
          revision: row.revision,
          updatedAt: row.updated_at,
          preview: draftPreview(row.text),
          attachmentCount: attachmentIdsOf(row).length,
        }));
        return { drafts };
      })();
    },

    get(principalId, draftId) {
      return db.transaction(() => {
        authorize(principalId);
        const row = readDraft(draftId);
        if (!row) throw notFound();
        if (row.deleted_at !== null) throw deleted(row);
        return toDraft(row);
      })();
    },

    save(principalId, draftId, input) {
      return db.transaction((): DraftSaveResponse => {
        const at = now();
        authorize(principalId);
        sweepPending(at);
        const fingerprint = sha256("save", String(input.ifMatch), JSON.stringify([input.sessionId, input.text, input.attachmentIds]));
        const replay = receipt(draftId, "save", input.idempotencyKey, fingerprint);
        if (replay !== undefined) return replay as DraftSaveResponse;

        const row = readDraft(draftId);
        if (row?.deleted_at != null) throw deleted(row);
        if (!row && input.ifMatch !== 0) throw notFound();
        if (row && input.ifMatch !== row.revision) throw conflict(row);
        // Binding is its own proven operation; a save cannot move a draft.
        if (row && input.sessionId !== row.session_id) throw conflict(row);

        if (input.text.length === 0 && input.attachmentIds.length === 0) {
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
        if (!row) {
          const live = (db.query("SELECT COUNT(*) AS n FROM session_drafts WHERE deleted_at IS NULL").get() as { n: number }).n;
          if (live >= limits.maxDrafts) {
            throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host holds the most drafts it keeps.", limit: limits.maxDrafts, bound: "drafts" });
          }
        }
        const previousTextBytes = row ? utf8Bytes(row.text) : 0;
        if (textBytes > previousTextBytes && totalBytes() - previousTextBytes + textBytes > limits.maxTotalBytes) {
          throw new DraftError(507, { error: "DRAFT_CAPACITY", message: "This host's draft storage is full.", limit: limits.maxTotalBytes, bound: "total" });
        }

        const revision = (row?.revision ?? 0) + 1;
        const ids = JSON.stringify(input.attachmentIds);
        if (row) {
          db.prepare(
            "UPDATE session_drafts SET revision = ?, text = ?, attachment_ids = ?, size_bytes = ?, updated_at = ?, updated_by = ? WHERE draft_id = ?"
          ).run(revision, input.text, ids, textBytes + imageBytes, at, principalId, draftId);
        } else {
          db.prepare(
            `INSERT INTO session_drafts (draft_id, session_id, revision, text, attachment_ids, size_bytes, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(draftId, input.sessionId, revision, input.text, ids, textBytes + imageBytes, at, principalId, at, principalId);
        }
        // An image the previous revision listed and this one dropped is gone;
        // an upload no revision has listed yet waits for its own save.
        const keep = new Set(input.attachmentIds);
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
        const fingerprint = sha256("attachment", input.mime, input.name ?? "", input.bytes);
        const replay = receipt(draftId, "attachment", input.idempotencyKey, fingerprint);
        if (replay !== undefined) return replay as DraftAttachmentResponse;

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
        tombstone(row, "deleted", principalId, at);
      }).immediate();
    },

    bind(principalId, draftId, input) {
      return db.transaction((): DraftBindResponse => {
        const at = now();
        authorize(principalId);
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
        if (!row || row.deleted_at !== null || row.revision !== revision) return "kept";
        if (row.session_id !== (input.resumed ? input.sessionId : null)) return "kept";
        tombstone(row, "sent", input.principalId, at);
        return "consumed";
      }).immediate();
    },
  };
}
