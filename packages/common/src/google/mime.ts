/**
 * The raw RFC 822 draft parser behind the send card (plan §4, "Send is bound
 * to the exact approved bytes").
 *
 * The host retrieves a draft's raw message and this parser reads, from
 * exactly those bytes, what the card must show: From, To, Cc, Bcc, Reply-To,
 * Subject, In-Reply-To, References and the text/plain body. It flags an HTML
 * part, an attachment and anything it cannot read; the host refuses a send
 * (`draft_not_displayable`) on any flag. It never guesses: an unknown
 * charset or transfer encoding, an RFC 2231 extended or continued form of a
 * parameter it relies on (`charset`, `boundary`), a malformed or repeated
 * header, a header that names addresses the card does not show, a multipart
 * subtype other than mixed, alternative and related, a broken multipart
 * structure, or decoded text holding a control or bidirectional embedding,
 * override or isolate character the card cannot show faithfully sets an
 * unreadable flag. Only a part with no disposition or an `inline` one can be
 * the body; any other disposition is an attachment. The digest covers the
 * input bytes exactly, so the host can send and record what the card was
 * built from.
 *
 * Address headers are parsed by the strict mailbox parser before any encoded
 * word is decoded, so an encoded word cannot add a recipient or split one.
 */
import { parseGoogleMailboxList, type GoogleMailbox } from "./address.js";
import {
  binaryToBytes, BODY_CONTROL, bytesToBinary, decodeBase64, decodeCharset, decodeEncodedWords, decodeQuotedPrintable, HEADER_CONTROL, sha256Hex,
} from "./encoding.js";

/** Why a part of the draft could not be read. Closed, and never carries draft text. */
export const GMAIL_RAW_DRAFT_PROBLEMS = [
  "too_large", "bare_cr", "header_syntax", "header_encoding", "header_control_character", "duplicate_header",
  "unshown_address_header", "address_syntax", "from_not_single", "encoded_word", "message_id_syntax",
  "content_type", "content_disposition", "extended_parameter", "transfer_encoding", "charset", "body_control_character",
  "multipart_subtype", "multipart_structure", "too_deep", "too_many_parts",
] as const;
export type GmailRawDraftProblem = typeof GMAIL_RAW_DRAFT_PROBLEMS[number];

/** What the parser read from one raw draft. Check the flags before trusting any field. */
export interface GmailRawDraft {
  /** sha256 of exactly the input bytes, lower-case hex. */
  digest: string;
  /** The input's length in bytes. */
  bytes: number;
  from: GoogleMailbox | null;
  to: GoogleMailbox[];
  cc: GoogleMailbox[];
  bcc: GoogleMailbox[];
  reply_to: GoogleMailbox[];
  /** The decoded subject, or null when absent or unreadable. */
  subject: string | null;
  /** Message ids, each with its angle brackets. */
  in_reply_to: string[];
  references: string[];
  /** The decoded text/plain body with line breaks as `\n`, or null when there is none or it is unreadable. */
  body_text: string | null;
  /** A text/html part exists anywhere in the message. */
  html_part: boolean;
  /** An attachment, a non-text part, or a second text part exists. */
  attachment: boolean;
  /** A header could not be read exactly; the header fields above may be incomplete. */
  unreadable_headers: boolean;
  /** The body structure or a text part could not be read exactly. */
  unreadable_body: boolean;
  /** Each distinct reason, in the order first met. */
  problems: GmailRawDraftProblem[];
}

/** The parser's bounds: larger, deeper or more fragmented input is unreadable rather than parsed in part. */
export const GMAIL_RAW_DRAFT_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  headerBytes: 256 * 1024,
  depth: 8,
  parts: 100,
});

/** Headers the card shows, each allowed once. */
const SINGLE = ["from", "to", "cc", "bcc", "reply-to", "subject", "in-reply-to", "references",
  "mime-version", "content-type", "content-transfer-encoding", "content-disposition", "sender"];
/** Headers that name a sender or recipient the card does not show. Their presence is unreadable. */
const UNSHOWN_ADDRESS = /^(?:sender|resent-[a-z-]+|disposition-notification-to|return-receipt-to)$/;
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
/**
 * The multipart subtypes the card can represent. Each defaults a child
 * without Content-Type to text/plain (RFC 2046 5.1). Every other subtype is
 * unreadable: digest children default to message/rfc822, and signed,
 * encrypted, parallel, report and the rest mean something the card does not
 * show.
 */
const MULTIPART_SUBTYPES = new Set(["mixed", "alternative", "related"]);
/** Parameters whose values the parser acts on; their RFC 2231 forms are never decoded, so they are unreadable. */
const RELIED_PARAMETERS = ["charset", "boundary"];
const MESSAGE_IDS = /^(?:[\t ]*<[\x21-\x3b\x3d\x3f-\x7e]+>)+[\t ]*$/;
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const CONTENT_TYPE = new RegExp(`^[\\t ]*(${TOKEN})/(${TOKEN})[\\t ]*(.*)$`, "s");
const DISPOSITION = new RegExp(`^[\\t ]*(${TOKEN})[\\t ]*(.*)$`, "s");
const PARAMETER = new RegExp(`^;[\\t ]*(${TOKEN})[\\t ]*=[\\t ]*(?:(${TOKEN})|"((?:[^"\\\\]|\\\\.)*)")[\\t ]*`, "s");

class Reader {
  readonly problems: GmailRawDraftProblem[] = [];
  unreadableHeaders = false;
  unreadableBody = false;
  html = false;
  attachment = false;
  body: string | null = null;
  parts = 0;

  header(problem: GmailRawDraftProblem): void {
    this.unreadableHeaders = true;
    if (!this.problems.includes(problem)) this.problems.push(problem);
  }

  structure(problem: GmailRawDraftProblem): void {
    this.unreadableBody = true;
    if (!this.problems.includes(problem)) this.problems.push(problem);
  }
}

type Headers = Map<string, string[]>;

/**
 * Splits an entity into unfolded headers and its body, both still binary
 * strings. Header bytes beyond ASCII must be UTF-8 (RFC 6532). Returns null
 * after recording the problem when the header block cannot be read.
 */
function readEntity(binary: string, reader: Reader, report: (problem: GmailRawDraftProblem) => void): { headers: Headers; body: string } | null {
  const headers: Headers = new Map();
  let at = 0;
  let current: { name: string; value: string } | null = null;
  const commit = (): boolean => {
    if (!current) return true;
    let value = current.value;
    if (/[\x80-\xff]/.test(value)) {
      const decoded = decodeCharset(binaryToBytes(value), "utf-8");
      if (decoded === null) {
        report("header_encoding");
        return false;
      }
      value = decoded;
    }
    if (HEADER_CONTROL.test(value)) {
      report("header_control_character");
      return false;
    }
    const list = headers.get(current.name) ?? [];
    list.push(value.replace(/^[\t ]+|[\t ]+$/g, ""));
    headers.set(current.name, list);
    current = null;
    return true;
  };
  while (true) {
    const newline = binary.indexOf("\n", at);
    const end = newline === -1 ? binary.length : newline;
    let line = binary.slice(at, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const next = newline === -1 ? binary.length : newline + 1;
    if (line.includes("\r")) {
      report("bare_cr");
      return null;
    }
    if (line.length === 0) {
      if (!commit()) return null;
      return { headers, body: newline === -1 ? "" : binary.slice(next) };
    }
    if (at > GMAIL_RAW_DRAFT_LIMITS.headerBytes) {
      report("header_syntax");
      return null;
    }
    if (line[0] === " " || line[0] === "\t") {
      if (!current) {
        report("header_syntax");
        return null;
      }
      current.value += line;
    } else {
      if (!commit()) return null;
      const colon = line.indexOf(":");
      const name = colon > 0 ? line.slice(0, colon) : "";
      if (!FIELD_NAME.test(name)) {
        report("header_syntax");
        return null;
      }
      current = { name: name.toLowerCase(), value: line.slice(colon + 1) };
    }
    if (newline === -1) {
      if (!commit()) return null;
      return { headers, body: "" };
    }
    at = next;
  }
}

/** Parameter values by exact name, every base name present, and the base names that appeared in an RFC 2231 form. */
interface Parameters { values: Map<string, string>; names: Set<string>; extended: Set<string> }

/** `; name=value` parameters. RFC 2231 forms (`name*`, `name*0`) count as present but are not decoded. */
function readParameters(rest: string): Parameters | null {
  const values = new Map<string, string>();
  const names = new Set<string>();
  const extended = new Set<string>();
  let text = rest;
  while (text.length > 0) {
    if (/^;[\t ]*$/.test(text)) break;
    const match = PARAMETER.exec(text);
    if (!match) return null;
    const name = match[1]!.toLowerCase();
    if (values.has(name)) return null;
    values.set(name, match[2] ?? match[3]!.replace(/\\(.)/g, "$1"));
    const base = name.split("*")[0]!;
    names.add(base);
    if (base !== name) extended.add(base);
    text = text.slice(match[0].length);
  }
  return { values, names, extended };
}

function contentType(value: string | undefined): { type: string; subtype: string; parameters: Parameters } | null {
  if (value === undefined) return { type: "text", subtype: "plain", parameters: { values: new Map([["charset", "us-ascii"]]), names: new Set(["charset"]), extended: new Set() } };
  if (value.includes("(")) return null;
  const match = CONTENT_TYPE.exec(value);
  if (!match) return null;
  const parameters = readParameters(match[3]!);
  if (!parameters) return null;
  return { type: match[1]!.toLowerCase(), subtype: match[2]!.toLowerCase(), parameters };
}

function disposition(value: string | undefined): { type: string; parameters: Parameters } | null | undefined {
  if (value === undefined) return undefined;
  if (value.includes("(")) return null;
  const match = DISPOSITION.exec(value);
  if (!match) return null;
  const parameters = readParameters(match[2]!);
  return parameters ? { type: match[1]!.toLowerCase(), parameters } : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** The body parts between `--boundary` delimiter lines, or null without a closing delimiter. */
function splitMultipart(body: string, boundary: string): string[] | null {
  const delimiter = new RegExp(`(^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[\\t ]*(\\r?\\n|$)`, "g");
  const parts: string[] = [];
  let start = -1;
  for (let match = delimiter.exec(body); match; match = delimiter.exec(body)) {
    if (start >= 0) parts.push(body.slice(start, Math.max(start, match.index)));
    if (match[2]) return parts;
    start = match.index + match[0].length;
    // The line break that ends this delimiter may also begin the next one.
    delimiter.lastIndex = start - match[3]!.length;
    if (match[3]!.length === 0) break;
  }
  return null;
}

function decodeTransfer(body: string, encoding: string): string | null {
  if (encoding === "7bit" || encoding === "8bit" || encoding === "binary") return body;
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  if (encoding === "base64") return decodeBase64(body);
  return null;
}

function readPart(headers: Headers, body: string, depth: number, reader: Reader): void {
  if (++reader.parts > GMAIL_RAW_DRAFT_LIMITS.parts) return reader.structure("too_many_parts");
  if (depth > GMAIL_RAW_DRAFT_LIMITS.depth) return reader.structure("too_deep");
  for (const name of ["content-type", "content-transfer-encoding", "content-disposition"]) {
    if ((headers.get(name)?.length ?? 0) > 1) return reader.structure("duplicate_header");
  }
  const type = contentType(headers.get("content-type")?.[0]);
  if (!type) return reader.structure("content_type");
  const encoding = (headers.get("content-transfer-encoding")?.[0] ?? "7bit").toLowerCase();
  const shown = disposition(headers.get("content-disposition")?.[0]);
  if (shown === null) return reader.structure("content_disposition");
  if (RELIED_PARAMETERS.some(name => type.parameters.extended.has(name))) return reader.structure("extended_parameter");
  const named = type.parameters.names.has("name") || shown?.parameters.names.has("filename") === true;
  // Only no disposition, or `inline`, leaves a part displayable; any other token is an attachment.
  const attached = (shown !== undefined && shown.type !== "inline") || named;

  if (type.type === "multipart") {
    if (!MULTIPART_SUBTYPES.has(type.subtype)) return reader.structure("multipart_subtype");
    if (encoding !== "7bit" && encoding !== "8bit" && encoding !== "binary") return reader.structure("transfer_encoding");
    const boundary = type.parameters.values.get("boundary");
    if (!boundary || boundary.length > 70) return reader.structure("multipart_structure");
    const parts = splitMultipart(body, boundary);
    if (!parts || parts.length === 0) return reader.structure("multipart_structure");
    if (attached) reader.attachment = true;
    for (const part of parts) {
      const entity = readEntity(part, reader, problem => reader.structure(problem));
      if (!entity) return;
      readPart(entity.headers, entity.body, depth + 1, reader);
    }
    return;
  }
  if (attached || type.type === "message") {
    reader.attachment = true;
    return;
  }
  if (type.type === "text" && type.subtype === "html") {
    reader.html = true;
    return;
  }
  if (type.type !== "text" || type.subtype !== "plain" || reader.body !== null) {
    // A non-text part, another text type, or a second text/plain part: nothing the card shows as the body.
    reader.attachment = true;
    return;
  }
  const decoded = decodeTransfer(body, encoding);
  if (decoded === null) return reader.structure("transfer_encoding");
  const text = decodeCharset(binaryToBytes(decoded), type.parameters.values.get("charset") ?? "us-ascii");
  if (text === null) return reader.structure("charset");
  if (BODY_CONTROL.test(text)) return reader.structure("body_control_character");
  reader.body = text.replace(/\r\n/g, "\n");
}

function readAddresses(headers: Headers, name: string, reader: Reader): GoogleMailbox[] {
  const value = headers.get(name)?.[0];
  if (value === undefined) return [];
  const parsed = parseGoogleMailboxList(value);
  if (!parsed.ok) {
    reader.header("address_syntax");
    return [];
  }
  return parsed.mailboxes;
}

function readMessageIds(headers: Headers, name: string, reader: Reader): string[] {
  const value = headers.get(name)?.[0];
  if (value === undefined) return [];
  if (!MESSAGE_IDS.test(value)) {
    reader.header("message_id_syntax");
    return [];
  }
  return value.match(/<[^>]+>/g) ?? [];
}

const EMPTY = (digest: string, bytes: number, problem: GmailRawDraftProblem): GmailRawDraft => ({
  digest, bytes, from: null, to: [], cc: [], bcc: [], reply_to: [], subject: null, in_reply_to: [], references: [],
  body_text: null, html_part: false, attachment: false, unreadable_headers: true, unreadable_body: true, problems: [problem],
});

/** Parses one raw draft. The digest is over `bytes` exactly, whatever else the parser can read. */
export async function parseGmailRawDraft(bytes: Uint8Array): Promise<GmailRawDraft> {
  const digest = await sha256Hex(bytes);
  if (bytes.length > GMAIL_RAW_DRAFT_LIMITS.bytes) return EMPTY(digest, bytes.length, "too_large");
  const reader = new Reader();
  const entity = readEntity(bytesToBinary(bytes), reader, problem => reader.header(problem));
  if (!entity) return { ...EMPTY(digest, bytes.length, reader.problems[0] ?? "header_syntax"), problems: reader.problems };
  const { headers, body } = entity;

  for (const name of headers.keys()) if (UNSHOWN_ADDRESS.test(name)) reader.header("unshown_address_header");
  for (const name of SINGLE) if ((headers.get(name)?.length ?? 0) > 1) reader.header("duplicate_header");

  const fromList = readAddresses(headers, "from", reader);
  if (fromList.length > 1) reader.header("from_not_single");
  const rawSubject = headers.get("subject")?.[0];
  let subject: string | null = null;
  if (rawSubject !== undefined) {
    subject = decodeEncodedWords(rawSubject);
    if (subject === null) reader.header("encoded_word");
  }
  const draft = {
    from: fromList.length === 1 ? fromList[0]! : null,
    to: readAddresses(headers, "to", reader),
    cc: readAddresses(headers, "cc", reader),
    bcc: readAddresses(headers, "bcc", reader),
    reply_to: readAddresses(headers, "reply-to", reader),
    subject,
    in_reply_to: readMessageIds(headers, "in-reply-to", reader),
    references: readMessageIds(headers, "references", reader),
  };
  readPart(headers, body, 0, reader);
  return {
    digest,
    bytes: bytes.length,
    ...draft,
    body_text: reader.unreadableBody ? null : reader.body,
    html_part: reader.html,
    attachment: reader.attachment,
    unreadable_headers: reader.unreadableHeaders,
    unreadable_body: reader.unreadableBody,
    problems: reader.problems,
  };
}
