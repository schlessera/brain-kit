/** What the extractor parent and child exchange (#3154). Internal; never on the wire. */

export interface ExtractRequest {
  /** 1-based, inclusive. */
  startPage: number;
  endPage: number;
  /** UTF-8 bytes of `startPage`'s text already returned by an earlier call. */
  offset: number;
  /** Most UTF-8 bytes of text, page markers included, this call returns. */
  maxBytes: number;
}

export type ExtractResponse =
  | { outcome: "text"; pageCount: number; pages: [number, number]; text: string; pagesWithoutText: number[]; next?: { page: number; offset: number } }
  | { outcome: "out_of_range"; pageCount: number }
  | { outcome: "encrypted" }
  | { outcome: "malformed" }
  | { outcome: "failed"; reason: "error" };

/** The marker that opens each page's text, so a reader always knows where it is. */
export function pageHeader(page: number, continued: boolean): string {
  return continued ? `[page ${page}, continued]\n` : `[page ${page}]\n`;
}

/** At most `max` bytes of UTF-8, never splitting a code point. */
export function cutUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = Math.max(0, max);
  // Step back over continuation bytes (10xxxxxx) to the start of a code point.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
