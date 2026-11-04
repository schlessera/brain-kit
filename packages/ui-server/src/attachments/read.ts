/**
 * The host half of `read_attachment` (#3154, docs/plans/chat-attachments.md
 * §7.2–7.3). One shared, bounded, local path serves both backends: a turn may
 * read only originals a message of its own session references, re-checked
 * against the record and the digest on every call. PDFs go to the extractor
 * child; text is a bounded byte-range read here. Every result says exactly
 * what it covers, and a cut-short one carries the cursor for the rest. No
 * extracted text is kept, and nothing here reaches the provider except the
 * tool result itself.
 */
import {
  ATTACHMENT_READ_MAX_CALL_BYTES, ATTACHMENT_READ_MAX_PAGES, ATTACHMENT_READ_MAX_TURN_BYTES,
  type AttachmentReadResult, type ReadAttachmentInput,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { AwaitableDraftStore } from "../drafts/store.js";
import { cutUtf8 } from "./extract-protocol.js";
import type { Extractor } from "./extract.js";
import { readVerified } from "./files.js";
import { FILE_ID, type AttachmentRow } from "./store.js";

/** What one turn's reads have returned so far; the bridge keeps one per turn. */
interface AttachmentReadBudget { used: number }

export interface AttachmentReadContext {
  brainRoot: string;
  store: Pick<AwaitableDraftStore, "attachments" | "attachmentRef" | "settled" | "recordAttachmentRead">;
  /** The calling turn's session; null before the backend reported one. */
  sessionId: string | null | undefined;
  turnId: string;
  signal: AbortSignal;
  budget: AttachmentReadBudget;
  /** Test seam for the per-turn bound; defaults to the contract's. */
  maxTurnBytes?: number;
}

/** Thrown when the turn was cancelled mid-read: nothing is returned or recorded. */
export class AttachmentReadCancelled extends Error {
  constructor() { super("The attachment read was cancelled with its turn."); this.name = "AttachmentReadCancelled"; }
}

// Cursors bind the file's digest, so one never continues a different file.
const PDF_CURSOR = /^p\.([a-f0-9]{12})\.(\d{1,6})\.(\d{1,9})\.(\d{1,6})$/;
const TEXT_CURSOR = /^t\.([a-f0-9]{12})\.(\d{1,9})$/;

function refused(id: string, message: string, row?: AttachmentRow): AttachmentReadResult {
  return { id, ...(row ? { name: row.stored_name, kind: row.kind } : {}), outcome: "refused", message };
}

export function createAttachmentReader(extractor: Extractor) {
  async function read(ctx: AttachmentReadContext, input: ReadAttachmentInput): Promise<AttachmentReadResult> {
    const id = input.id;
    if (!FILE_ID.test(id)) return refused(id, "No attachment has this id.");
    if (!ctx.sessionId) return refused(id, "This turn has no conversation yet, so it has no attachments.");
    // Read after every earlier acceptance on the write channel: the message reference is written there.
    await ctx.store.settled?.();
    const row = ctx.store.attachments([id]).get(id);
    // Draft and outgoing references are not readable by a turn; only this session's messages grant a read.
    if (!row || !ctx.store.attachmentRef(id, "message", ctx.sessionId)) return refused(id, "This conversation was not sent an attachment with this id.");
    if (row.state !== "stored") return refused(id, "This attachment was deleted.", row);
    const base = { id, name: row.stored_name, kind: row.kind } as const;
    const textual = row.reader === "text" || row.reader === "track";
    if (input.pages && row.reader !== "pdf") return refused(id, "pages applies to PDF attachments only; use cursor to continue a text file.", row);
    if (input.cursor && !(row.reader === "pdf" ? PDF_CURSOR : TEXT_CURSOR).test(input.cursor)) return refused(id, "This cursor does not belong to this attachment.", row);
    if (row.reader !== "pdf" && !textual) {
      return record(ctx, row, { ...base, outcome: "unavailable",
        message: row.kind === "image" ? "Images are shown inline, or opened at their path; there is no text reader for them."
          : row.kind === "archive" ? "Archives are not expanded here." : "There is no reader for this kind of file here." });
    }
    const original = await readVerified(ctx.brainRoot, row);
    if (!original.ok) {
      if (original.reason === "missing") return refused(id, "This attachment's original is no longer on disk.", row);
      return record(ctx, row, { ...base, outcome: "changed", message: "The original no longer matches what was stored. Nothing of it was returned." });
    }
    const sha = row.sha256.slice(0, 12);
    const remaining = (ctx.maxTurnBytes ?? ATTACHMENT_READ_MAX_TURN_BYTES) - ctx.budget.used;
    const maxBytes = Math.max(0, Math.min(ATTACHMENT_READ_MAX_CALL_BYTES, remaining));
    const budgetCut = maxBytes < ATTACHMENT_READ_MAX_CALL_BYTES;
    const result = row.reader === "pdf"
      ? await readPdf(ctx, row, base, original.bytes, input, sha, maxBytes, budgetCut)
      : readText(row, base, original.bytes, input, sha, maxBytes, budgetCut);
    if (result.outcome === "refused") return result;
    ctx.budget.used += Buffer.byteLength(result.text ?? "");
    return record(ctx, row, result);
  }

  async function readPdf(ctx: AttachmentReadContext, row: AttachmentRow, base: Pick<AttachmentReadResult, "id" | "name" | "kind">, bytes: Uint8Array,
    input: ReadAttachmentInput, sha: string, maxBytes: number, budgetCut: boolean): Promise<AttachmentReadResult> {
    let start = 1, end = ATTACHMENT_READ_MAX_PAGES, offset = 0;
    if (input.cursor) {
      const [, digest, page, at, last] = PDF_CURSOR.exec(input.cursor)!;
      if (digest !== sha) return refused(base.id, "This cursor does not belong to this attachment.", row);
      start = Number(page); offset = Number(at); end = Number(last);
    } else if (input.pages) {
      const [first, last] = input.pages.split("-");
      start = Number(first); end = Number(last ?? first);
    }
    if (end < start) return refused(base.id, "The page range ends before it starts.", row);
    if (end - start + 1 > ATTACHMENT_READ_MAX_PAGES) return refused(base.id, `At most ${ATTACHMENT_READ_MAX_PAGES} pages per call; ask for a smaller range.`, row);
    const done = await extractor.extract(bytes, { startPage: start, endPage: end, offset, maxBytes }, ctx.signal);
    if (done.outcome === "cancelled" || ctx.signal.aborted) throw new AttachmentReadCancelled();
    switch (done.outcome) {
      case "unavailable": return { ...base, outcome: "unavailable", message: "The PDF reader could not start on this host." };
      case "failed": return { ...base, outcome: "failed", reason: done.reason, message: done.reason === "timeout" ? "Reading these pages took too long and was stopped."
        : done.reason === "resource_limit" ? "Reading these pages hit the reader's CPU or memory limit." : "The PDF reader failed on this document." };
      case "encrypted": return { ...base, outcome: "encrypted", message: "This PDF needs a password. None is supplied and nothing is decrypted." };
      case "malformed": return { ...base, outcome: "malformed", message: "This file is not a readable PDF." };
      case "out_of_range": return refused(base.id, `This PDF has ${done.pageCount} page${done.pageCount === 1 ? "" : "s"}.`, row);
    }
    const scope = { pages: done.pages, pageCount: done.pageCount };
    const next = done.next ? `p.${sha}.${done.next.page}.${done.next.offset}.${Math.min(end, done.pageCount)}` : undefined;
    const blank = done.pagesWithoutText.length ? { pagesWithoutText: done.pagesWithoutText } : {};
    if (!done.text && !next) return { ...base, outcome: "no_text", scope, ...blank,
      message: "These pages have no extractable text, as in a scanned document. No OCR is run." };
    const notes = [
      ...(next ? [budgetCut ? "This turn's reading budget is spent; continue with next in a later turn." : "The output bound was reached; continue with next."] : []),
      ...(done.pagesWithoutText.length ? [`Page${done.pagesWithoutText.length === 1 ? "" : "s"} ${done.pagesWithoutText.join(", ")} had no extractable text; no OCR is run.`] : []),
      // Never let a requested range read as the whole document.
      ...(done.pages[0] > 1 || done.pages[1] < done.pageCount ? [`This PDF has ${done.pageCount} pages; this result covers ${done.pages[0] === done.pages[1] ? `page ${done.pages[0]}` : `pages ${done.pages[0]}-${done.pages[1]}`}.`] : []),
    ];
    return { ...base, outcome: next || done.pagesWithoutText.length ? "partial" : "read", scope, ...blank,
      ...(next ? { truncated: true, next } : {}), ...(notes.length ? { message: notes.join(" ") } : {}), text: done.text };
  }

  function readText(row: AttachmentRow, base: Pick<AttachmentReadResult, "id" | "name" | "kind">, bytes: Uint8Array,
    input: ReadAttachmentInput, sha: string, maxBytes: number, budgetCut: boolean): AttachmentReadResult {
    let start = 0;
    if (input.cursor) {
      const [, digest, at] = TEXT_CURSOR.exec(input.cursor)!;
      start = Number(at);
      // A cursor starts on a code point inside this file, as every one this reader hands out does.
      if (digest !== sha || start >= bytes.length || (bytes[start]! & 0xc0) === 0x80) return refused(base.id, "This cursor does not belong to this attachment.", row);
    }
    const slice = cutUtf8(bytes.subarray(start), maxBytes);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(slice); }
    catch { return { ...base, outcome: "malformed", message: "This file is not valid UTF-8 text." }; }
    const end = start + slice.length;
    const scope = { bytes: [start, end] as [number, number], totalBytes: bytes.length };
    if (end >= bytes.length) return { ...base, outcome: "read", scope, text };
    return { ...base, outcome: "partial", scope, truncated: true, next: `t.${sha}.${end}`, text,
      message: budgetCut ? "This turn's reading budget is spent; continue with next in a later turn." : "The output bound was reached; continue with next." };
  }

  /** A read that reached an authorized original is recorded for the UI; a failed record never fails the read. */
  async function record(ctx: AttachmentReadContext, row: AttachmentRow, result: AttachmentReadResult): Promise<AttachmentReadResult> {
    if (result.outcome !== "refused" && ctx.sessionId) {
      try { await ctx.store.recordAttachmentRead({ fileId: row.file_id, sessionId: ctx.sessionId, turnId: ctx.turnId, outcome: result.outcome, scope: result.scope ?? null }); }
      catch { /* The read happened; only its display status is lost. */ }
    }
    return result;
  }

  return { read };
}

export type AttachmentReader = ReturnType<typeof createAttachmentReader>;
