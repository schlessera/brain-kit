/**
 * The byte-level decoders the address and draft parsers share: charsets,
 * RFC 2047 encoded words, quoted-printable, base64 and the sha256 digest.
 *
 * Every decoder answers `null` for input it cannot read exactly, so a caller
 * marks it unreadable instead of guessing. Only WHATWG globals are used
 * (`TextDecoder`, `atob`, `crypto.subtle`), never a Node built-in.
 */

/** Bytes as a string of code units 0-255, one per byte, so byte offsets and string offsets agree. */
export function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return out;
}

/** The inverse of {@link bytesToBinary}. Every code unit must be a byte. */
export function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at) & 0xff;
  return bytes;
}

const UTF8 = new Set(["utf-8", "utf8"]);
const ASCII = new Set(["us-ascii", "ascii", "ansi_x3.4-1968"]);
const LATIN1 = new Set(["iso-8859-1", "iso8859-1", "iso_8859-1", "latin1", "latin-1", "l1"]);

/**
 * Decodes bytes in one of the charsets a v1 draft may use: UTF-8 (strict),
 * US-ASCII (every byte below 0x80) and ISO-8859-1 (each byte is its code
 * point; WHATWG's `TextDecoder` would read that label as windows-1252, so it
 * is decoded by hand). Any other charset is unreadable.
 */
export function decodeCharset(bytes: Uint8Array, charset: string): string | null {
  const name = charset.trim().toLowerCase();
  if (UTF8.has(name)) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  if (ASCII.has(name)) {
    for (const byte of bytes) if (byte > 0x7f) return null;
    return bytesToBinary(bytes);
  }
  if (LATIN1.has(name)) return bytesToBinary(bytes);
  return null;
}

/** A strict base64 decode to a binary string: whitespace ignored, padding required, nothing else allowed. */
export function decodeBase64(text: string): string | null {
  const compact = text.replace(/[\t\n\r ]+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    return atob(compact);
  } catch {
    return null;
  }
}

/**
 * A quoted-printable body decode (RFC 2045 section 6.7) to a binary string.
 * Unencoded whitespace at the end of a line is transport padding and is
 * deleted (rule 3); encoded whitespace (`=20`, `=09`) is kept. A line ending
 * in `=` is a soft line break and joins the next one. Any other `=` must
 * start a hex pair.
 */
export function decodeQuotedPrintable(text: string): string | null {
  let out = "";
  const pieces = text.split(/(\r?\n)/);
  for (let index = 0; index < pieces.length; index += 2) {
    let line = pieces[index]!.replace(/[\t ]+$/, "");
    const soft = line.endsWith("=");
    if (soft) line = line.slice(0, -1);
    for (let at = 0; at < line.length; at++) {
      const char = line[at]!;
      if (char !== "=") {
        out += char;
        continue;
      }
      const pair = line.slice(at + 1, at + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(pair)) return null;
      out += String.fromCharCode(parseInt(pair, 16));
      at += 2;
    }
    if (!soft) out += pieces[index + 1] ?? "";
  }
  return out;
}

/** The `Q` encoding of an encoded word (RFC 2047 §4.2) to a binary string. */
function decodeQ(text: string): string | null {
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "_") out += " ";
    else if (char === "=") {
      const pair = text.slice(at + 1, at + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(pair)) return null;
      out += String.fromCharCode(parseInt(pair, 16));
      at += 2;
    } else if (char.charCodeAt(0) < 0x21 || char.charCodeAt(0) > 0x7e) return null;
    else out += char;
  }
  return out;
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
/**
 * The bidirectional embedding, override and isolate controls (U+202A-U+202E,
 * U+2066-U+2069). They reorder the text around them, so a card showing a
 * value that holds one would not show it faithfully.
 */
export const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
/**
 * C0 and C1 controls and DEL, tab excepted, and the bidirectional controls:
 * what no header value or decoded header text may hold.
 */
export const HEADER_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/;
/**
 * What no body a send card shows may hold: C0 controls but tab, line feed
 * and a carriage return that starts a CRLF; DEL; C1 controls; and the
 * bidirectional controls. Joiners, marks and other ordinary text stay
 * displayable. The draft input schema and the raw-draft parser both apply
 * it, so a draft brain-kit writes is one the card can show.
 */
export const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]|\r(?!\n)/;

/**
 * Decodes the RFC 2047 encoded words in header text. Whitespace between two
 * adjacent encoded words is dropped (§6.2); other text is kept as written.
 * An encoded word in an unknown charset or encoding, or one whose decoded
 * text holds a control or bidirectional embedding, override or isolate
 * character, makes the whole text unreadable (`null`).
 */
export function decodeEncodedWords(text: string): string | null {
  let out = "";
  let last = 0;
  let previousWasWord = false;
  for (const match of text.matchAll(ENCODED_WORD)) {
    const between = text.slice(last, match.index);
    if (!(previousWasWord && /^[ \t]+$/.test(between))) out += between;
    const charset = match[1]!.split("*")[0]!; // RFC 2231 language suffix
    const binary = match[2]!.toUpperCase() === "B" ? decodeBase64(match[3]!) : decodeQ(match[3]!);
    if (binary === null) return null;
    const decoded = decodeCharset(binaryToBytes(binary), charset);
    if (decoded === null || HEADER_CONTROL.test(decoded)) return null;
    out += decoded;
    last = match.index + match[0].length;
    previousWasWord = true;
  }
  out += text.slice(last);
  return out;
}

/** sha256 over exactly these bytes, lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
