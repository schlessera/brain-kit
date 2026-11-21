/**
 * Strict codecs from gog v0.48.1's JSON to the records of `../records.ts`
 * (plan §8, "Strict codecs per operation").
 *
 * Shapes, from gog's source at the pinned tag:
 *
 * - `gmail search --ids-only`: `{threads: [{id}], nextPageToken, count,
 *   has_more}` (internal/cmd/gmail_search.go, paged_list_helpers.go).
 * - `gmail thread get`: `{thread: <Gmail Thread, format full>, downloaded}`
 *   (internal/cmd/gmail_thread.go).
 * - `gmail get --format=full`: `{message: <Gmail Message>, headers, body?,
 *   attachments?, unsubscribe?}` (internal/cmd/gmail_get.go).
 * - `gmail drafts get --format=raw`: `{draft: {id, message?: {…, raw}}}`
 *   (internal/cmd/gmail_drafts.go).
 * - `gmail labels list`: `{labels: [<Gmail Label>]}` (gmail_labels.go).
 *
 * gog's own envelopes must have exactly their known keys: a new or missing
 * key there is a gog change the shape check has to look at. Inside Gmail's
 * own resources (Thread, Message, MessagePart, Label), every field read must
 * have its type and unknown fields are ignored, because Google adds fields
 * to its v1 resources without a version change. Any other deviation is a
 * {@link GogShapeError}, which the transport answers as
 * `transport_incompatible`; no field is ever guessed.
 */
import type {
  GmailAttachmentRecord, GmailDraftRecord, GmailLabelRecord, GmailMessageRecord, GmailSearchHitRecord, GmailThreadRecord,
} from "../records.js";
import { parseGmailRawDraft, type GmailRawDraft } from "../mime.js";
import {
  contentTypeParameter, decodeBase64Url, decodeHtmlEntities, decodeText, headerText, htmlToText, mediaType, rawMessageHeaders,
  unwrapGogUntrusted,
} from "./payload.js";

/** A shape the codec does not read. `path` locates it; no value is ever carried. */
export class GogShapeError extends Error {
  constructor(readonly path: string) {
    super(`unexpected gog output at ${path}`);
    this.name = "GogShapeError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function object(value: unknown, path: string): Json {
  if (!isObject(value)) throw new GogShapeError(path);
  return value;
}

/** A gog envelope: exactly these keys, the required ones present. */
function envelope(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Json {
  const record = object(value, path);
  for (const key of required) if (!(key in record)) throw new GogShapeError(`${path}.${key}`);
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) throw new GogShapeError(`${path}.${key}`);
  return record;
}

function string(record: Json, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new GogShapeError(`${path}.${key}`);
  return value;
}

function optionalString(record: Json, key: string, path: string): string | null {
  if (record[key] === undefined) return null;
  return string(record, key, path);
}

function id(record: Json, key: string, path: string): string {
  const value = string(record, key, path);
  if (value.length === 0 || value.length > 256) throw new GogShapeError(`${path}.${key}`);
  return value;
}

function optionalCount(record: Json, key: string, path: string): number | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new GogShapeError(`${path}.${key}`);
  return value;
}

function optionalArray(record: Json, key: string, path: string): unknown[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new GogShapeError(`${path}.${key}`);
  return value;
}

function strings(record: Json, key: string, path: string): string[] {
  return optionalArray(record, key, path).map((item, index) => {
    if (typeof item !== "string") throw new GogShapeError(`${path}.${key}[${index}]`);
    return item;
  });
}

/** Gmail's millisecond `internalDate`, which the Go client writes as a decimal string, as RFC 3339 UTC. */
function internalDate(record: Json, path: string): string | null {
  const value = record.internalDate;
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new GogShapeError(`${path}.internalDate`);
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) throw new GogShapeError(`${path}.internalDate`);
  return date.toISOString();
}

// ------------------------------------------------------------- messages

interface Part {
  path: string;
  mimeType: string;
  filename: string;
  headers: Map<string, string>;
  data: string | null;
  attachmentId: string | null;
  size: number | null;
  parts: Part[];
}

const MAX_DEPTH = 32;
const MAX_PARTS = 1000;

function part(value: unknown, path: string, depth: number, budget: { parts: number }): Part {
  if (depth > MAX_DEPTH || --budget.parts < 0) throw new GogShapeError(path);
  const record = object(value, path);
  const headers = new Map<string, string>();
  optionalArray(record, "headers", path).forEach((item, index) => {
    const header = object(item, `${path}.headers[${index}]`);
    const name = string(header, "name", `${path}.headers[${index}]`).toLowerCase();
    const text = string(header, "value", `${path}.headers[${index}]`);
    if (!headers.has(name)) headers.set(name, text);
  });
  const body = record.body === undefined ? {} : object(record.body, `${path}.body`);
  return {
    path,
    mimeType: optionalString(record, "mimeType", path) ?? "",
    filename: optionalString(record, "filename", path) ?? "",
    headers,
    data: optionalString(body, "data", `${path}.body`),
    attachmentId: optionalString(body, "attachmentId", `${path}.body`),
    size: optionalCount(body, "size", `${path}.body`),
    parts: optionalArray(record, "parts", path).map((child, index) => part(child, `${path}.parts[${index}]`, depth + 1, budget)),
  };
}

function walk(root: Part | null): Part[] {
  if (!root) return [];
  const out: Part[] = [];
  const visit = (node: Part) => {
    out.push(node);
    node.parts.forEach(visit);
  };
  visit(root);
  return out;
}

const isAttachment = (node: Part) =>
  node.filename.length > 0 || node.attachmentId !== null || /^\s*attachment\b/i.test(node.headers.get("content-disposition") ?? "");

function partText(node: Part): string {
  const bytes = decodeBase64Url(node.data ?? "");
  if (!bytes) throw new GogShapeError(`${node.path}.body.data`);
  const contentType = node.headers.get("content-type") ?? node.mimeType;
  return decodeText(bytes, contentTypeParameter(contentType, "charset")).replace(/^\uFEFF/, "");
}

/** The text body: the first inline text/plain part with text, else the first inline text/html part as text. */
function bodyText(nodes: Part[]): string | null {
  const inline = nodes.filter(node => !isAttachment(node) && node.data !== null);
  const plain = inline.filter(node => mediaType(node.mimeType) === "text/plain").map(partText);
  const text = plain.find(candidate => candidate.trim().length > 0);
  if (text !== undefined) return text.replace(/\r\n/g, "\n");
  const html = inline.find(node => mediaType(node.mimeType) === "text/html");
  if (html) return htmlToText(partText(html));
  return plain[0]?.replace(/\r\n/g, "\n") ?? null;
}

function attachments(nodes: Part[]): GmailAttachmentRecord[] {
  return nodes.filter(node => isAttachment(node) && !mediaType(node.mimeType).startsWith("multipart/")).map(node => ({
    filename: node.filename.length > 0 ? unwrapGogUntrusted(node.filename) : null,
    mime_type: node.mimeType.length > 0 ? mediaType(node.mimeType) : null,
    size: node.size,
  }));
}

const header = (root: Part | null, name: string): string | null => {
  const value = root?.headers.get(name);
  return value === undefined ? null : headerText(value);
};

/** One Gmail Message resource (format full) as a record. */
export function decodeGmailMessage(value: unknown, path: string): GmailMessageRecord {
  const record = object(value, path);
  const root = record.payload === undefined ? null : part(record.payload, `${path}.payload`, 0, { parts: MAX_PARTS });
  const nodes = walk(root);
  const snippet = optionalString(record, "snippet", path);
  return {
    id: id(record, "id", path),
    thread_id: id(record, "threadId", path),
    label_ids: strings(record, "labelIds", path),
    internal_date: internalDate(record, path),
    size_estimate: optionalCount(record, "sizeEstimate", path),
    from: header(root, "from"),
    to: header(root, "to"),
    cc: header(root, "cc"),
    bcc: header(root, "bcc"),
    reply_to: header(root, "reply-to"),
    subject: header(root, "subject"),
    date: header(root, "date"),
    snippet: snippet === null ? null : decodeHtmlEntities(unwrapGogUntrusted(snippet)),
    body_text: bodyText(nodes),
    attachments: attachments(nodes),
  };
}

function decodeThread(value: unknown, path: string): GmailThreadRecord {
  const record = object(value, path);
  return {
    id: id(record, "id", path),
    messages: optionalArray(record, "messages", path).map((message, index) => decodeGmailMessage(message, `${path}.messages[${index}]`)),
  };
}

// --------------------------------------------------------------- results

/** `gmail thread get <id> --json`. */
export function decodeGogThread(json: unknown): GmailThreadRecord {
  const top = envelope(json, "$", ["thread", "downloaded"]);
  if (top.downloaded !== null && !(Array.isArray(top.downloaded) && top.downloaded.length === 0)) throw new GogShapeError("$.downloaded");
  return decodeThread(top.thread, "$.thread");
}

const GET_HEADERS = ["from", "reply_to", "to", "cc", "bcc", "subject", "date", "message_id", "in_reply_to", "references"];

/** `gmail get <id> --format=full --json`. The record is built from `message`; gog's flattened copies are only checked. */
export function decodeGogMessage(json: unknown): GmailMessageRecord {
  const top = envelope(json, "$", ["message", "headers"], ["body", "attachments", "unsubscribe"]);
  const headers = envelope(top.headers, "$.headers", GET_HEADERS);
  for (const key of GET_HEADERS) string(headers, key, "$.headers");
  optionalString(top, "body", "$");
  optionalString(top, "unsubscribe", "$");
  optionalArray(top, "attachments", "$");
  return decodeGmailMessage(top.message, "$.message");
}

/** `gmail labels list --json`. */
export function decodeGogLabels(json: unknown): GmailLabelRecord[] {
  const top = envelope(json, "$", ["labels"]);
  return optionalArray(top, "labels", "$").map((item, index) => {
    const path = `$.labels[${index}]`;
    const label = object(item, path);
    const name = optionalString(label, "name", path);
    return {
      id: id(label, "id", path),
      name: name === null ? null : unwrapGogUntrusted(name),
      messages_total: optionalCount(label, "messagesTotal", path),
      messages_unread: optionalCount(label, "messagesUnread", path),
      threads_total: optionalCount(label, "threadsTotal", path),
      threads_unread: optionalCount(label, "threadsUnread", path),
    };
  });
}

/** One page of `gmail search --ids-only --json`: the thread ids, in Gmail's order, and the next page token. */
export interface GogSearchIds {
  thread_ids: string[];
  next_page_token: string | null;
}

const SEARCH_ITEM_KEYS = ["id", "date", "internalDateIso", "from", "subject", "labels", "messageCount"];

export function decodeGogSearchIds(json: unknown): GogSearchIds {
  const top = envelope(json, "$", ["threads", "nextPageToken"], ["count", "has_more"]);
  optionalCount(top, "count", "$");
  if (top.has_more !== undefined && typeof top.has_more !== "boolean") throw new GogShapeError("$.has_more");
  const token = string(top, "nextPageToken", "$");
  const ids = optionalArray(top, "threads", "$").map((item, index) => id(envelope(item, `$.threads[${index}]`, ["id"], SEARCH_ITEM_KEYS), "id", `$.threads[${index}]`));
  return { thread_ids: [...new Set(ids)], next_page_token: token.length > 0 ? token : null };
}

/**
 * One search hit from the thread read the transport makes for it: the union
 * of every message's labels (what `hidden_labels` filtering relies on, plan
 * §5), and the newest message's headers and snippet.
 */
export function searchHitFromThread(thread: GmailThreadRecord): GmailSearchHitRecord {
  const labels = [...new Set(thread.messages.flatMap(message => message.label_ids))];
  let newest: GmailMessageRecord | null = null;
  for (const message of thread.messages) {
    if (!newest || (message.internal_date ?? "") >= (newest.internal_date ?? "")) newest = message;
  }
  const sizes = thread.messages.map(message => message.size_estimate).filter((size): size is number => size !== null);
  return {
    thread_id: thread.id,
    message_count: thread.messages.length,
    label_ids: labels,
    latest_internal_date: newest?.internal_date ?? null,
    size_estimate: sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) : null,
    has_attachment: thread.messages.some(message => message.attachments.length > 0),
    from: newest?.from ?? null,
    to: newest?.to ?? null,
    cc: newest?.cc ?? null,
    subject: newest?.subject ?? null,
    snippet: newest?.snippet ?? null,
  };
}

/** A draft read: the record, the raw bytes it was read from, and the send card's parse of them. */
export interface GogDraftRead {
  draft: GmailDraftRecord;
  /** The draft's exact RFC 822 bytes, or null when the draft has no message. */
  raw: Uint8Array | null;
  parsed: GmailRawDraft | null;
}

/**
 * `gmail drafts get <id> --format=raw --json`. The headers are the raw
 * message's own, the body is what the send card's parser reads from the same
 * bytes, and the message has one attachment entry of unknown metadata when
 * the parser found anything besides its text: a raw read does not list
 * parts, and a v1 send refuses any of them.
 */
export async function decodeGogDraft(json: unknown): Promise<GogDraftRead> {
  const top = envelope(json, "$", ["draft"]);
  const draft = object(top.draft, "$.draft");
  const draftId = id(draft, "id", "$.draft");
  if (draft.message === undefined || draft.message === null) return { draft: { id: draftId, message: null }, raw: null, parsed: null };
  const path = "$.draft.message";
  const message = object(draft.message, path);
  const raw = decodeBase64Url(string(message, "raw", path));
  if (!raw || raw.length === 0) throw new GogShapeError(`${path}.raw`);
  const parsed = await parseGmailRawDraft(raw);
  const headers = rawMessageHeaders(raw);
  const snippet = optionalString(message, "snippet", path);
  const record: GmailMessageRecord = {
    id: id(message, "id", path),
    thread_id: id(message, "threadId", path),
    label_ids: strings(message, "labelIds", path),
    internal_date: internalDate(message, path),
    size_estimate: optionalCount(message, "sizeEstimate", path),
    from: headers.get("from") ?? null,
    to: headers.get("to") ?? null,
    cc: headers.get("cc") ?? null,
    bcc: headers.get("bcc") ?? null,
    reply_to: headers.get("reply-to") ?? null,
    subject: headers.get("subject") ?? null,
    date: headers.get("date") ?? null,
    snippet: snippet === null ? null : decodeHtmlEntities(unwrapGogUntrusted(snippet)),
    body_text: parsed.body_text,
    attachments: parsed.attachment ? [{ filename: null, mime_type: null, size: null }] : [],
  };
  return { draft: { id: draftId, message: record }, raw, parsed };
}
