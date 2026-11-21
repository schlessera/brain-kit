/**
 * Text out of Gmail's message payloads, for the read codecs: header values,
 * the text body of a MIME part tree, attachment metadata, snippets, and the
 * headers of a raw RFC 822 message.
 *
 * Read text is untrusted and is shown, never sent, so this decodes as
 * faithfully as it can rather than refusing (the send card's strict parser is
 * `../mime.ts`): an unknown charset falls back to Latin-1, an unreadable
 * encoded word stays as written. What it never does is guess a shape: the
 * codecs check every field's type before anything here reads it.
 */
import { bytesToBinary, decodeEncodedWords } from "../encoding.js";

/** gog's `--wrap-untrusted` envelope (internal/outfmt/untrusted.go), which brain-kit never asks for. */
const GOG_WRAPPED = /^(?:SECURITY NOTICE:[\s\S]*?\n\n)?<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{16})">>>\nSource: [^\n]*\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/;

/** The text inside gog's untrusted-content markers, if a later default adds them; otherwise the text as given. */
export function unwrapGogUntrusted(text: string): string {
  const match = GOG_WRAPPED.exec(text);
  return match ? match[2]! : text;
}

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** The HTML character references Gmail writes into snippets and HTML bodies. Unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]{2,8});/g, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

/** One header value as shown: unfolded, encoded words decoded where they can be, gog's markers removed. */
export function headerText(value: string): string {
  const unfolded = unwrapGogUntrusted(value).replace(/\r?\n(?=[ \t])/g, "");
  return /=\?[^?\s]+\?[BbQq]\?/.test(unfolded) ? decodeEncodedWords(unfolded) ?? unfolded : unfolded;
}

/** Gmail's base64url `body.data` (padding optional) to bytes, or null when it is not base64url. */
export function decodeBase64Url(data: string): Uint8Array | null {
  const compact = data.replace(/[\t\n\r ]+/g, "");
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(compact)) return null;
  const unpadded = compact.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  const standard = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Bytes as text. Gmail often normalises `body.data` to UTF-8 while the part
 * still names its original charset, so valid UTF-8 is read as UTF-8 first;
 * otherwise the named charset if the runtime knows it, else Latin-1.
 */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: fall through to the declared charset.
  }
  if (charset) {
    try {
      return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
    } catch {
      // An unknown label.
    }
  }
  return bytesToBinary(bytes);
}

const BLOCK_END = /<\/(?:p|div|li|tr|h[1-6]|table|blockquote|pre|section|article|header|footer|ul|ol|dt|dd)\s*>/gi;

/** A plain-text reading of an HTML body: markup, scripts and styles removed, block ends as line breaks, references decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_END, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .split("\n").map(line => line.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A MIME media type without parameters, lower case. */
export function mediaType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/** A Content-Type parameter's value, unquoted, or null. */
export function contentTypeParameter(contentType: string | null, name: string): string | null {
  if (!contentType) return null;
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * The first value of each header of a raw RFC 822 message, by lower-case
 * name, unfolded, as text. Only the header block is read.
 */
export function rawMessageHeaders(raw: Uint8Array): Map<string, string> {
  const binary = bytesToBinary(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
  const end = binary.search(/\r?\n\r?\n/);
  const block = end === -1 ? binary : binary.slice(0, end);
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(name)) continue;
    const bytes = new Uint8Array(line.length - colon - 1);
    for (let at = colon + 1; at < line.length; at++) bytes[at - colon - 1] = line.charCodeAt(at) & 0xff;
    headers.set(name, headerText(decodeText(bytes, null).trim()));
  }
  return headers;
}
