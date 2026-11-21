/**
 * Projections from codec records to the results a Google read returns
 * (plan §6, "What structured means, exactly").
 *
 * **Structured** results are built field by field, never by copying a
 * record, and every value in them passed one validator from a closed set:
 *
 * - a Gmail message, thread or draft id, or a label id, matching its shape
 *   (system labels from the closed list only);
 * - a label name from the account's label list, escaped and capped
 *   ({@link escapeGmailLabelName});
 * - an RFC 3339 timestamp; a non-negative integer; a size bucket; a boolean;
 *   a closed enum (label type);
 * - a host-minted cursor ({@link isGoogleHostCursor}); minting is the host's.
 *
 * A value that fails its validator is dropped (null, or left out of a list),
 * never passed through. An item whose own id fails is left out whole. No
 * header, address, name, subject, snippet, body or attachment name can reach
 * a structured result.
 *
 * **Content** results add, under one `untrusted` key per item, the text a
 * third party wrote: from, to, cc, bcc, reply-to, subject, date header,
 * snippet, the text body and attachment metadata, bounded and truncated as
 * plan §9 says. A content result taints the session (`google_result`) before
 * it returns; that is the host's job, not this module's.
 *
 * Neither projection enforces `hidden_labels`: the host filters records
 * before projecting them.
 */
import { GMAIL_LIMITS } from "./catalog.js";
import { gmailLabelKind, isGmailDraftId, isGmailMessageId, isGmailThreadId, isGoogleHostCursor, isKnownGmailLabelId } from "./ids.js";
import type {
  GmailAttachmentRecord, GmailDraftRecord, GmailLabelRecord, GmailMessageRecord, GmailSearchHitRecord, GmailSearchPageRecord, GmailThreadRecord,
} from "./records.js";

// --------------------------------------------------------------- validators

/** Size buckets (plan §4): the exact size is sender-controlled, so only its order of magnitude is structured. */
export const GMAIL_SIZE_BUCKETS = ["under_10kb", "under_100kb", "under_1mb", "1mb_or_more"] as const;
export type GmailSizeBucket = typeof GMAIL_SIZE_BUCKETS[number];

/** A safe integer of zero or more. */
export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The bucket of a size in bytes (10 KiB, 100 KiB, 1 MiB boundaries), or null when it is not a size. */
export function gmailSizeBucket(bytes: unknown): GmailSizeBucket | null {
  if (!isNonNegativeInteger(bytes)) return null;
  if (bytes < 10 * 1024) return "under_10kb";
  if (bytes < 100 * 1024) return "under_100kb";
  if (bytes < 1024 * 1024) return "under_1mb";
  return "1mb_or_more";
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** An RFC 3339 date-time with a real calendar date, upper-case `T` and `Z`, and no leap second. */
export function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (match[8] !== "Z" && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
  return true;
}

/**
 * Characters a label name cannot show as themselves: controls (`Cc`), format
 * characters (`Cf`: the bidirectional controls, zero-width characters and
 * tags), surrogates, unassigned code points, line and paragraph separators,
 * every other default-ignorable code point, and the backslash, so that an
 * escape is never ambiguous.
 */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\\]/gu;

/** The longest escaped name: 225 code points, each at most `\u{10FFFF}` (ten characters). */
export const GMAIL_LABEL_NAME_ESCAPED_MAX = GMAIL_LIMITS.labelNameChars * 10;

/**
 * A label name made safe to show (ruling 5): each unshowable character
 * becomes a visible `\u{XXXX}` escape and a backslash becomes `\\`.
 *
 * The 225-character cap applies **before** escaping, to the name as Gmail
 * stores it, counted in code points: Gmail never mints a longer name, so a
 * longer value is not a label name and is dropped (null), never truncated.
 * An escaped name may therefore be longer than 225 characters, up to
 * {@link GMAIL_LABEL_NAME_ESCAPED_MAX}. An empty name is dropped.
 */
export function escapeGmailLabelName(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  if ([...name].length > GMAIL_LIMITS.labelNameChars) return null;
  return name.replace(UNSHOWABLE, char =>
    char === "\\" ? "\\\\" : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/**
 * Label id to name, from the account's label list. It holds raw names; the
 * projections escape every name they output, so a directory built by hand
 * cannot carry an unescaped one.
 */
export type GmailLabelDirectory = ReadonlyMap<string, string>;

export function gmailLabelDirectory(labels: readonly GmailLabelRecord[]): GmailLabelDirectory {
  const directory = new Map<string, string>();
  for (const label of labels) {
    if (isKnownGmailLabelId(label.id) && typeof label.name === "string") directory.set(label.id, label.name);
  }
  return directory;
}

// ------------------------------------------------------------------ results

export interface GmailStructuredLabel {
  id: string;
  name: string | null;
}

export interface GmailStructuredMessage {
  message_id: string;
  thread_id: string | null;
  labels: GmailStructuredLabel[];
  internal_date: string | null;
  size_bucket: GmailSizeBucket | null;
  unread: boolean | null;
  starred: boolean | null;
  has_attachment: boolean | null;
  attachment_count: number | null;
}

export interface GmailUntrustedAttachment {
  filename: string | null;
  mime_type: string | null;
  size: number | null;
}

/** Everything a third party could have written about one message. Never instructions. */
export interface GmailUntrustedMessage {
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  body_text: string | null;
  body_truncated: boolean;
  /** The body's full length in characters, or null without a body. */
  body_length: number | null;
  attachments: GmailUntrustedAttachment[];
}

export interface GmailContentMessage extends GmailStructuredMessage {
  untrusted: GmailUntrustedMessage;
}

export interface GmailStructuredMessageResult { view: "structured"; message: GmailStructuredMessage }
export interface GmailContentMessageResult { view: "content"; message: GmailContentMessage }

export interface GmailStructuredThread { view: "structured"; thread_id: string; message_count: number; messages: GmailStructuredMessage[] }
export interface GmailContentThread { view: "content"; thread_id: string; message_count: number; messages: GmailContentMessage[] }

export interface GmailStructuredDraft { view: "structured"; draft_id: string; message: GmailStructuredMessage | null }
export interface GmailContentDraft { view: "content"; draft_id: string; message: GmailContentMessage | null }

export interface GmailStructuredSearchHit {
  thread_id: string;
  message_count: number | null;
  labels: GmailStructuredLabel[];
  latest_internal_date: string | null;
  size_bucket: GmailSizeBucket | null;
  unread: boolean | null;
  starred: boolean | null;
  has_attachment: boolean | null;
}

export interface GmailUntrustedSearchHit {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
}

export interface GmailContentSearchHit extends GmailStructuredSearchHit {
  untrusted: GmailUntrustedSearchHit;
}

export interface GmailStructuredSearch {
  view: "structured";
  threads: GmailStructuredSearchHit[];
  next_cursor: string | null;
  result_size_estimate: number | null;
}

export interface GmailContentSearch {
  view: "content";
  threads: GmailContentSearchHit[];
  next_cursor: string | null;
  result_size_estimate: number | null;
}

export const GMAIL_LABEL_TYPES = ["system", "user"] as const;
export type GmailLabelType = typeof GMAIL_LABEL_TYPES[number];

export interface GmailStructuredLabelEntry {
  id: string;
  name: string | null;
  type: GmailLabelType;
  messages_total: number | null;
  messages_unread: number | null;
  threads_total: number | null;
  threads_unread: number | null;
}

/** The label list is always structured: label names are the owner's configuration (ruling 5). */
export interface GmailStructuredLabelList { view: "structured"; labels: GmailStructuredLabelEntry[] }

export interface GmailProjectionContext {
  /** Names for label ids, from the account's label list. Without it every name is null. */
  labels?: GmailLabelDirectory;
}

export interface GmailSearchProjectionContext extends GmailProjectionContext {
  /** The host cursor the host minted for the next page, or null on the last page. */
  cursor: string | null;
}

// -------------------------------------------------------------- structured

const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const count = (value: unknown): number | null => isNonNegativeInteger(value) ? value : null;
const timestamp = (value: unknown): string | null => isRfc3339Timestamp(value) ? value : null;
const list = (value: unknown): readonly unknown[] | null => Array.isArray(value) ? value : null;

function knownLabelIds(value: unknown): string[] | null {
  const ids = list(value);
  if (!ids) return null;
  return [...new Set(ids.filter(isKnownGmailLabelId))];
}

function labelsOf(ids: readonly string[] | null, context: GmailProjectionContext): GmailStructuredLabel[] {
  return (ids ?? []).map(id => ({ id, name: escapeGmailLabelName(context.labels?.get(id)) }));
}

/** One message, structured, or null when its id is not a Gmail message id. */
export function structuredGmailMessage(record: GmailMessageRecord, context: GmailProjectionContext = {}): GmailStructuredMessage | null {
  if (!isGmailMessageId(record?.id)) return null;
  const ids = knownLabelIds(record.label_ids);
  const attachments = list(record.attachments);
  return {
    message_id: record.id,
    thread_id: isGmailThreadId(record.thread_id) ? record.thread_id : null,
    labels: labelsOf(ids, context),
    internal_date: timestamp(record.internal_date),
    size_bucket: gmailSizeBucket(record.size_estimate),
    unread: ids ? ids.includes("UNREAD") : null,
    starred: ids ? ids.includes("STARRED") : null,
    has_attachment: attachments ? attachments.length > 0 : null,
    attachment_count: attachments ? attachments.length : null,
  };
}

export function structuredGmailMessageResult(record: GmailMessageRecord, context: GmailProjectionContext = {}): GmailStructuredMessageResult | null {
  const message = structuredGmailMessage(record, context);
  return message ? { view: "structured", message } : null;
}

export function structuredGmailThread(record: GmailThreadRecord, context: GmailProjectionContext = {}): GmailStructuredThread | null {
  if (!isGmailThreadId(record?.id)) return null;
  const messages = (list(record.messages) ?? []).flatMap(message => {
    const projected = structuredGmailMessage(message as GmailMessageRecord, context);
    return projected ? [projected] : [];
  });
  return { view: "structured", thread_id: record.id, message_count: messages.length, messages };
}

export function structuredGmailDraft(record: GmailDraftRecord, context: GmailProjectionContext = {}): GmailStructuredDraft | null {
  if (!isGmailDraftId(record?.id)) return null;
  return { view: "structured", draft_id: record.id, message: record.message ? structuredGmailMessage(record.message, context) : null };
}

function structuredHit(hit: GmailSearchHitRecord, context: GmailProjectionContext): GmailStructuredSearchHit | null {
  if (!isGmailThreadId(hit?.thread_id)) return null;
  const ids = knownLabelIds(hit.label_ids);
  return {
    thread_id: hit.thread_id,
    message_count: count(hit.message_count),
    labels: labelsOf(ids, context),
    latest_internal_date: timestamp(hit.latest_internal_date),
    size_bucket: gmailSizeBucket(hit.size_estimate),
    unread: ids ? ids.includes("UNREAD") : null,
    starred: ids ? ids.includes("STARRED") : null,
    has_attachment: flag(hit.has_attachment),
  };
}

export function structuredGmailSearch(page: GmailSearchPageRecord, context: GmailSearchProjectionContext): GmailStructuredSearch {
  const threads = (list(page?.hits) ?? []).flatMap(hit => {
    const projected = structuredHit(hit as GmailSearchHitRecord, context);
    return projected ? [projected] : [];
  });
  return {
    view: "structured",
    threads,
    next_cursor: isGoogleHostCursor(context.cursor) ? context.cursor : null,
    result_size_estimate: count(page?.result_size_estimate),
  };
}

export function structuredGmailLabels(records: readonly GmailLabelRecord[]): GmailStructuredLabelList {
  const seen = new Set<string>();
  const labels = (list(records) ?? []).flatMap(value => {
    const record = value as GmailLabelRecord;
    const kind = gmailLabelKind(record?.id);
    if ((kind !== "system" && kind !== "user") || seen.has(record.id)) return [];
    seen.add(record.id);
    const entry: GmailStructuredLabelEntry = {
      id: record.id,
      name: escapeGmailLabelName(record.name),
      type: kind,
      messages_total: count(record.messages_total),
      messages_unread: count(record.messages_unread),
      threads_total: count(record.threads_total),
      threads_unread: count(record.threads_unread),
    };
    return [entry];
  });
  return { view: "structured", labels };
}

// ----------------------------------------------------------------- content

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max);
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return text.slice(0, cut);
}

const bounded = (value: unknown, max: number): string | null => typeof value === "string" ? truncate(value, max) : null;

function untrustedAttachments(value: unknown): GmailUntrustedAttachment[] {
  return (list(value) ?? []).map(item => {
    const attachment = (item ?? {}) as GmailAttachmentRecord;
    return {
      filename: bounded(attachment.filename, GMAIL_LIMITS.attachmentNameChars),
      mime_type: bounded(attachment.mime_type, GMAIL_LIMITS.attachmentNameChars),
      size: count(attachment.size),
    };
  });
}

function untrustedMessage(record: GmailMessageRecord, bodyBudget: number): GmailUntrustedMessage {
  const body = typeof record.body_text === "string" ? record.body_text : null;
  const shown = body === null ? null : truncate(body, Math.min(bodyBudget, GMAIL_LIMITS.messageBodyChars));
  return {
    from: bounded(record.from, GMAIL_LIMITS.headerChars),
    to: bounded(record.to, GMAIL_LIMITS.headerChars),
    cc: bounded(record.cc, GMAIL_LIMITS.headerChars),
    bcc: bounded(record.bcc, GMAIL_LIMITS.headerChars),
    reply_to: bounded(record.reply_to, GMAIL_LIMITS.headerChars),
    subject: bounded(record.subject, GMAIL_LIMITS.headerChars),
    date: bounded(record.date, GMAIL_LIMITS.headerChars),
    snippet: bounded(record.snippet, GMAIL_LIMITS.snippetChars),
    body_text: shown,
    body_truncated: body !== null && shown!.length < body.length,
    body_length: body === null ? null : body.length,
    attachments: untrustedAttachments(record.attachments),
  };
}

/** One message with its untrusted text; the body is capped at 32 KiB characters. */
export function contentGmailMessage(record: GmailMessageRecord, context: GmailProjectionContext = {}): GmailContentMessage | null {
  const structured = structuredGmailMessage(record, context);
  return structured ? { ...structured, untrusted: untrustedMessage(record, GMAIL_LIMITS.messageBodyChars) } : null;
}

export function contentGmailMessageResult(record: GmailMessageRecord, context: GmailProjectionContext = {}): GmailContentMessageResult | null {
  const message = contentGmailMessage(record, context);
  return message ? { view: "content", message } : null;
}

/** A thread with its untrusted text; bodies share a 128 KiB-character budget, in thread order. */
export function contentGmailThread(record: GmailThreadRecord, context: GmailProjectionContext = {}): GmailContentThread | null {
  if (!isGmailThreadId(record?.id)) return null;
  let budget: number = GMAIL_LIMITS.threadBodyChars;
  const messages = (list(record.messages) ?? []).flatMap(value => {
    const message = value as GmailMessageRecord;
    const structured = structuredGmailMessage(message, context);
    if (!structured) return [];
    const untrusted = untrustedMessage(message, budget);
    budget = Math.max(0, budget - (untrusted.body_text?.length ?? 0));
    return [{ ...structured, untrusted }];
  });
  return { view: "content", thread_id: record.id, message_count: messages.length, messages };
}

export function contentGmailDraft(record: GmailDraftRecord, context: GmailProjectionContext = {}): GmailContentDraft | null {
  if (!isGmailDraftId(record?.id)) return null;
  return { view: "content", draft_id: record.id, message: record.message ? contentGmailMessage(record.message, context) : null };
}

export function contentGmailSearch(page: GmailSearchPageRecord, context: GmailSearchProjectionContext): GmailContentSearch {
  const threads = (list(page?.hits) ?? []).flatMap(value => {
    const hit = value as GmailSearchHitRecord;
    const structured = structuredHit(hit, context);
    if (!structured) return [];
    const untrusted: GmailUntrustedSearchHit = {
      from: bounded(hit.from, GMAIL_LIMITS.headerChars),
      to: bounded(hit.to, GMAIL_LIMITS.headerChars),
      cc: bounded(hit.cc, GMAIL_LIMITS.headerChars),
      subject: bounded(hit.subject, GMAIL_LIMITS.headerChars),
      snippet: bounded(hit.snippet, GMAIL_LIMITS.snippetChars),
    };
    return [{ ...structured, untrusted }];
  });
  return {
    view: "content",
    threads,
    next_cursor: isGoogleHostCursor(context.cursor) ? context.cursor : null,
    result_size_estimate: count(page?.result_size_estimate),
  };
}
