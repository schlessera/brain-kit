/**
 * Pure readings of the untrusted text a Gmail payload carries (#4209): who
 * an address header names, and where a body's quoted history starts. Both
 * only decide how text is laid out; neither changes a character of it, and
 * neither trusts what it reads. Every string still reaches the screen through
 * `Field` or `UntrustedText`.
 *
 * Trimming removes mail whitespace only: space, tab, carriage return and line
 * feed. A byte-order mark, a line or paragraph separator, a no-break space or
 * any other character JavaScript's `trim` would drop stays in the slice, so
 * `revealInvisibles` sees every code point the guard promises to show.
 */

/** Space, tab, CR and LF: the only characters a reading may trim. */
const MAIL_SPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** `text` without mail whitespace at its end (and at its start, unless `endOnly`). A loop, so a long run of spaces costs linear time. */
function trimMail(text: string, endOnly = false): string {
  let start = 0;
  let end = text.length;
  while (!endOnly && start < end && MAIL_SPACE.has(text.charCodeAt(start))) start++;
  while (end > start && MAIL_SPACE.has(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

const blank = (line: string) => trimMail(line) === "";

/** One mailbox as written in a header, split into what a reader needs. */
interface MailboxReading {
  /** The display name, unquoted: "Penelope". `null` when the header has none. */
  name: string | null;
  /** The address: "penelope@example.com". `null` when the header has none. */
  address: string | null;
}

/**
 * The mailboxes in an address header, as written: a comma splits two
 * mailboxes only outside a quoted name, an angle-bracketed address and a
 * comment. `"Laertes, son of Arcesius" <laertes@example.com>, eumaeus@example.com`
 * is two.
 */
export function splitMailboxes(header: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < header.length) current += header[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "(") comment++;
    else if (ch === ")" && comment > 0) comment--;
    else if (ch === "," && angle === 0 && comment === 0) {
      if (!blank(current)) out.push(trimMail(current));
      current = "";
      continue;
    }
    current += ch;
  }
  if (!blank(current)) out.push(trimMail(current));
  return out;
}

/** One mailbox's display name and address. Tolerant: a header that is neither shape is its own name. */
export function readMailbox(mailbox: string): MailboxReading {
  const text = trimMail(mailbox);
  const angled = /^(.*?)<([^<>]*)>[ \t\r\n]*$/s.exec(text);
  if (angled) {
    const name = unquote(trimMail(angled[1]!));
    const address = trimMail(angled[2]!);
    return { name: name || null, address: address || null };
  }
  if (/^[^ \t\r\n@]+@[^ \t\r\n@]+$/.test(text)) return { name: null, address: text };
  return { name: unquote(text) || null, address: null };
}

function unquote(name: string): string {
  const quoted = /^"(.*)"$/s.exec(name);
  return trimMail(quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : name);
}

/** The words a reader knows a mailbox by: its display name, else its address, else the header as written. */
export function mailboxLabel(mailbox: string): string {
  const reading = readMailbox(mailbox);
  return reading.name ?? reading.address ?? trimMail(mailbox);
}

/** Every mailbox in a header by the words a reader knows it by: "Odysseus, Eumaeus". */
export function mailboxLabels(header: string): string[] {
  return splitMailboxes(header).map(mailboxLabel);
}

/** A body split before its trailing quoted history (ruling G3). */
interface QuotedTail {
  /** What the sender wrote, up to the attribution or the first trailing quote. */
  body: string;
  /** The "On … wrote:" line (or two) before the quote, when there is one. */
  attribution: string | null;
  /** The trailing quote blocks, as written, with their `>` markers. */
  quoted: string;
}

// The same block markers `parseUntrusted` reads, so a line this calls a quote
// is a line the renderer draws as one.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?/;
const ATTRIBUTION_ONE = /^\s*On\s.*\bwrote:\s*$/;
const ATTRIBUTION_START = /^\s*On\s/;
const ATTRIBUTION_END = /\bwrote:\s*$/;

/**
 * The quoted history at the end of a body, kit-side (ruling G3): the
 * trailing run of quote blocks `parseUntrusted` would draw, with an optional
 * "On … wrote:" line (one line, or two when the client wrapped it) before
 * it. A quote with the sender's own words after it is part of what they
 * wrote and stays where it is: this only ever takes the end.
 *
 * `null` when there is nothing to fold: no trailing quote, a quote inside a
 * code fence, or a body that is nothing but the quote (folding it would hide
 * the whole message).
 */
export function splitQuotedTail(text: string): QuotedTail | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Which lines sit inside a fenced code block, read the way the parser reads them.
  const fenced: boolean[] = [];
  let marker: string | null = null;
  for (const line of lines) {
    if (marker !== null) {
      fenced.push(true);
      if (line.trimStart().startsWith(marker)) marker = null;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) marker = fence[1]!;
    fenced.push(fence !== null);
  }

  let end = lines.length;
  while (end > 0 && blank(lines[end - 1]!)) end--;
  let start = end;
  while (start > 0) {
    const line = lines[start - 1]!;
    if (blank(line) || (!fenced[start - 1] && QUOTE.test(line))) start--;
    else break;
  }
  while (start < end && blank(lines[start]!)) start++;
  if (start >= end) return null;

  let cut = start;
  while (cut > 0 && blank(lines[cut - 1]!)) cut--;
  let attribution: string | null = null;
  const last = lines[cut - 1];
  const before = lines[cut - 2];
  if (last !== undefined && !fenced[cut - 1] && ATTRIBUTION_ONE.test(last)) {
    attribution = trimMail(last);
    cut -= 1;
  } else if (last !== undefined && before !== undefined && !fenced[cut - 1] && !fenced[cut - 2] && ATTRIBUTION_END.test(last) && ATTRIBUTION_START.test(before) && !ATTRIBUTION_END.test(before)) {
    attribution = `${trimMail(before)}\n${trimMail(last)}`;
    cut -= 2;
  }

  const body = trimMail(lines.slice(0, cut).join("\n"), true);
  if (blank(body)) return null;
  return { body, attribution, quoted: lines.slice(start, end).join("\n") };
}
