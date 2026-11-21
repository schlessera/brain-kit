/**
 * The one strict mailbox parser every Google address check uses (plan §5,
 * "Addresses are matched by one strict parser"): send recipients against
 * `gmail.send_to`, draft input, and the headers of a raw draft.
 *
 * It reads a subset of RFC 5322 and refuses the rest:
 *
 * - each mailbox is an addr-spec, optionally inside angle brackets after a
 *   display name; the display name is parsed (so a quoted `@` or `,` cannot
 *   split it) and then ignored for matching;
 * - group syntax (`team: a@x, b@y;`), comments (`(…)`), quoted local parts
 *   (`"a b"@x`), domain literals (`a@[192.0.2.1]`), whitespace inside an
 *   addr-spec, every control character and the bidirectional embedding,
 *   override and isolate controls are refused;
 * - the local part is a dot-atom of ASCII characters, compared exactly as
 *   written: RFC 5322 leaves its case to the receiving domain, so brain-kit
 *   does not fold it;
 * - the domain is compared as lower-case ASCII, an internationalised name in
 *   its punycode form, and never matches a subdomain.
 *
 * Anything it cannot parse is a typed refusal, never a best guess.
 */
import { decodeEncodedWords } from "./encoding.js";

/** One parsed mailbox. */
export interface GoogleMailbox {
  /** `local@domain` with the domain in lower-case ASCII (punycode): what every match compares. */
  address: string;
  /** The local part exactly as written. */
  local: string;
  /** The domain in lower-case ASCII, internationalised labels as punycode. */
  domain: string;
  /** The display name with quoting removed and encoded words decoded, or null. Shown, never matched. */
  display_name: string | null;
}

export const GOOGLE_ADDRESS_REFUSALS = [
  "empty", "too_long", "control_character", "group_syntax", "comment", "quoted_local_part", "domain_literal",
  "invalid_local_part", "invalid_domain", "invalid_display_name", "malformed",
] as const;
export type GoogleAddressRefusal = typeof GOOGLE_ADDRESS_REFUSALS[number];

export type GoogleMailboxResult = { ok: true; mailbox: GoogleMailbox } | { ok: false; reason: GoogleAddressRefusal };
export type GoogleMailboxListResult =
  | { ok: true; mailboxes: GoogleMailbox[] }
  | { ok: false; reason: GoogleAddressRefusal; index: number };
export type GoogleDomainResult = { ok: true; domain: string } | { ok: false; reason: "invalid_domain" };

/** The longest single mailbox, display name included, and the longest header value, in characters. */
export const GOOGLE_MAILBOX_MAX_CHARS = 512;
export const GOOGLE_ADDRESS_LIST_MAX_CHARS = 32_768;

const LOCAL_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PART = new RegExp(`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*$`);
/** Before IDNA: Unicode letters, marks and digits, hyphens and ASCII dots, at least two labels. */
const RAW_DOMAIN = /^[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+$/u;
const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * Every control character, tab included, the line and paragraph separators,
 * and the bidirectional embedding, override and isolate controls, which
 * reorder how a display name reads: none belongs in an address.
 */
const CONTROL = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
/** RFC 5322 specials that may not appear unquoted in a display name; `.` is allowed (obs-phrase). */
const PHRASE_SPECIALS = /[()<>[\]:;@\\,"]/;

/**
 * A domain in the form every comparison uses: lower-case ASCII, punycode for
 * internationalised labels, through the WHATWG URL host parser. Only ASCII
 * dots separate labels (IDNA's other full stops are refused, not mapped), an
 * IP address is not a domain, and the top-level label must hold a letter.
 */
export function normalizeGoogleDomain(raw: string): GoogleDomainResult {
  const refused = { ok: false, reason: "invalid_domain" } as const;
  if (raw.length === 0 || raw.length > 253 || !RAW_DOMAIN.test(raw)) return refused;
  let host: string;
  try {
    host = new URL(`http://${raw}`).hostname;
  } catch {
    return refused;
  }
  const labels = host.split(".");
  if (host.length > 253 || labels.length !== raw.split(".").length) return refused;
  if (!labels.every(label => ASCII_LABEL.test(label))) return refused;
  if (!/[a-z]/.test(labels[labels.length - 1]!)) return refused;
  return { ok: true, domain: host };
}

/** A bare addr-spec, without display name or angle brackets. */
function parseAddrSpec(spec: string): { ok: true; local: string; domain: string } | { ok: false; reason: GoogleAddressRefusal } {
  if (spec.length === 0) return { ok: false, reason: "empty" };
  if (spec.startsWith("\"")) return { ok: false, reason: "quoted_local_part" };
  if (/[\t ]/.test(spec)) return { ok: false, reason: "malformed" };
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) return { ok: false, reason: "malformed" };
  const local = spec.slice(0, at);
  const rawDomain = spec.slice(at + 1);
  if (local.includes("\"")) return { ok: false, reason: "quoted_local_part" };
  if (local.length > 64 || !LOCAL_PART.test(local)) return { ok: false, reason: "invalid_local_part" };
  if (rawDomain.startsWith("[")) return { ok: false, reason: "domain_literal" };
  const domain = normalizeGoogleDomain(rawDomain);
  if (!domain.ok) return domain;
  return { ok: true, local, domain: domain.domain };
}

/** A display name: words that are atoms (`.` allowed) or quoted strings. Null when it cannot be read. */
function parseDisplayName(phrase: string): string | null {
  const words: string[] = [];
  let at = 0;
  while (at < phrase.length) {
    const char = phrase[at]!;
    if (char === " " || char === "\t") {
      at++;
      continue;
    }
    if (char === "\"") {
      let word = "";
      let closed = false;
      for (at++; at < phrase.length; at++) {
        const inner = phrase[at]!;
        if (inner === "\\") {
          if (at + 1 >= phrase.length) return null;
          word += phrase[++at]!;
        } else if (inner === "\"") {
          closed = true;
          at++;
          break;
        } else word += inner;
      }
      if (!closed) return null;
      words.push(word);
      continue;
    }
    let atom = "";
    while (at < phrase.length && phrase[at] !== " " && phrase[at] !== "\t" && phrase[at] !== "\"") {
      if (PHRASE_SPECIALS.test(phrase[at]!)) return null;
      atom += phrase[at++];
    }
    // Encoded words are decoded only in atoms (RFC 2047 §5), after the structure is fixed.
    const decoded = decodeEncodedWords(atom);
    if (decoded === null) return null;
    words.push(decoded);
  }
  return words.join(" ");
}

/** Where the structure of a list or mailbox is visible: characters outside quoted strings. */
interface Scan { refusal: GoogleAddressRefusal | null; commas: number[]; angleOpen: number[]; angleClose: number[] }

function scan(text: string): Scan {
  const result: Scan = { refusal: null, commas: [], angleOpen: [], angleClose: [] };
  let quoted = false;
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quoted) {
      if (char === "\\") at++;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "(") return { ...result, refusal: "comment" };
    else if ((char === ":" || char === ";") && depth === 0) return { ...result, refusal: "group_syntax" };
    else if (char === "<") {
      depth++;
      result.angleOpen.push(at);
    } else if (char === ">") {
      depth--;
      result.angleClose.push(at);
      if (depth < 0) return { ...result, refusal: "malformed" };
    } else if (char === "," && depth === 0) result.commas.push(at);
  }
  if (quoted || depth !== 0) return { ...result, refusal: "malformed" };
  return result;
}

function mailboxFrom(text: string): GoogleMailboxResult {
  const trimmed = text.replace(/^[\t ]+|[\t ]+$/g, "");
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const structure = scan(trimmed);
  if (structure.refusal) return { ok: false, reason: structure.refusal };
  if (structure.commas.length > 0) return { ok: false, reason: "malformed" };
  let spec = trimmed;
  let display_name: string | null = null;
  if (structure.angleOpen.length > 0) {
    if (structure.angleOpen.length !== 1 || structure.angleClose.length !== 1 || structure.angleClose[0] !== trimmed.length - 1) {
      return { ok: false, reason: "malformed" };
    }
    const open = structure.angleOpen[0]!;
    spec = trimmed.slice(open + 1, -1);
    const phrase = trimmed.slice(0, open).replace(/[\t ]+$/, "");
    if (phrase.length > 0) {
      display_name = parseDisplayName(phrase);
      if (display_name === null) return { ok: false, reason: "invalid_display_name" };
    }
  } else if (structure.angleClose.length > 0) return { ok: false, reason: "malformed" };
  const parsed = parseAddrSpec(spec);
  if (!parsed.ok) return parsed;
  return { ok: true, mailbox: { address: `${parsed.local}@${parsed.domain}`, local: parsed.local, domain: parsed.domain, display_name } };
}

/** Parses exactly one mailbox (`addr-spec` or `display-name <addr-spec>`). */
export function parseGoogleMailbox(text: string): GoogleMailboxResult {
  if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "empty" };
  if (text.length > GOOGLE_MAILBOX_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (CONTROL.test(text.replace(/\t/g, " "))) return { ok: false, reason: "control_character" };
  return mailboxFrom(text);
}

/**
 * Parses an unfolded address-list header value: mailboxes separated by
 * commas outside quoted strings and angle brackets. An empty value is an
 * empty list; an empty element (`a@x, , b@y`) is refused, and so is the whole
 * list when any one mailbox is.
 */
export function parseGoogleMailboxList(text: string): GoogleMailboxListResult {
  if (typeof text !== "string") return { ok: false, reason: "malformed", index: 0 };
  if (text.length > GOOGLE_ADDRESS_LIST_MAX_CHARS) return { ok: false, reason: "too_long", index: 0 };
  if (CONTROL.test(text.replace(/\t/g, " "))) return { ok: false, reason: "control_character", index: 0 };
  if (/^[\t ]*$/.test(text)) return { ok: true, mailboxes: [] };
  const structure = scan(text);
  if (structure.refusal) return { ok: false, reason: structure.refusal, index: 0 };
  const pieces: string[] = [];
  let start = 0;
  for (const comma of structure.commas) {
    pieces.push(text.slice(start, comma));
    start = comma + 1;
  }
  pieces.push(text.slice(start));
  const mailboxes: GoogleMailbox[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.length > GOOGLE_MAILBOX_MAX_CHARS) return { ok: false, reason: "too_long", index };
    const parsed = mailboxFrom(piece);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, index };
    mailboxes.push(parsed.mailbox);
  }
  return { ok: true, mailboxes };
}

/**
 * One `gmail.send_to` (or later `calendar.invite`) entry: `self`, `*@domain`
 * for exactly that domain, or one full address. A display name, a wildcard
 * anywhere else and an unparseable address are refused, so a policy schema
 * can reject the entry and a matcher never treats it as matching.
 */
export type GoogleAllowListEntry =
  | { kind: "self" }
  | { kind: "domain"; domain: string }
  | { kind: "address"; address: string };

export type GoogleAllowListEntryResult = { ok: true; entry: GoogleAllowListEntry } | { ok: false; reason: GoogleAddressRefusal };

export function parseGoogleAllowListEntry(entry: string): GoogleAllowListEntryResult {
  if (typeof entry !== "string" || entry.length === 0) return { ok: false, reason: "empty" };
  if (entry.length > GOOGLE_MAILBOX_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (CONTROL.test(entry)) return { ok: false, reason: "control_character" };
  if (entry === "self") return { ok: true, entry: { kind: "self" } };
  if (entry.startsWith("*@")) {
    const domain = normalizeGoogleDomain(entry.slice(2));
    return domain.ok ? { ok: true, entry: { kind: "domain", domain: domain.domain } } : domain;
  }
  if (entry.includes("*")) return { ok: false, reason: "invalid_local_part" };
  if (entry.includes("(")) return { ok: false, reason: "comment" };
  if (/[<>]/.test(entry)) return { ok: false, reason: "malformed" };
  const parsed = parseAddrSpec(entry);
  return parsed.ok ? { ok: true, entry: { kind: "address", address: `${parsed.local}@${parsed.domain}` } } : parsed;
}

/** One address's verdict: the entry it matched as written in the policy, or null. */
export interface GoogleAllowListMatch {
  input: string;
  mailbox: GoogleMailbox | null;
  entry: string | null;
}

/**
 * Matches each address against the allow-list. An address is parsed as one
 * mailbox; one that does not parse matches nothing. `self` matches only the
 * host-supplied `self` addresses (the account's primary address and verified
 * send-as aliases), compared the same way; an unparseable `self` address is
 * ignored. A malformed entry matches nothing, and an empty list matches
 * nothing.
 */
export function matchGoogleAllowList(addresses: readonly string[], entries: readonly string[], self: readonly string[]): GoogleAllowListMatch[] {
  const parsedEntries = entries.flatMap(entry => {
    const parsed = parseGoogleAllowListEntry(entry);
    return parsed.ok ? [{ raw: entry, entry: parsed.entry }] : [];
  });
  const selfAddresses = new Set(self.flatMap(address => {
    const parsed = parseGoogleMailbox(address);
    return parsed.ok ? [parsed.mailbox.address] : [];
  }));
  return addresses.map(input => {
    const parsed = parseGoogleMailbox(input);
    if (!parsed.ok) return { input, mailbox: null, entry: null };
    const mailbox = parsed.mailbox;
    const hit = parsedEntries.find(({ entry }) =>
      entry.kind === "self" ? selfAddresses.has(mailbox.address)
        : entry.kind === "domain" ? mailbox.domain === entry.domain
          : mailbox.address === entry.address);
    return { input, mailbox, entry: hit?.raw ?? null };
  });
}

/**
 * Whether every address matches an entry. An empty address list matches
 * nothing too: no recipient is never a reason to admit a send.
 */
export function matchesAllowList(addresses: readonly string[], entries: readonly string[], self: readonly string[]): boolean {
  if (addresses.length === 0) return false;
  return matchGoogleAllowList(addresses, entries, self).every(match => match.entry !== null);
}
