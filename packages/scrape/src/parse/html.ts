/**
 * HTML → structured data, via cheerio.
 *
 * cheerio rather than Bun's native `HTMLRewriter`, which was measured against
 * it: HTMLRewriter is streaming and dependency-free, but it is a transform API
 * with no ancestor traversal and no re-query, so the card-shaped extraction
 * every site adapter actually does ("find the links, then walk up to the card,
 * then read its sibling text") becomes a hand-written state machine. cheerio
 * was also the faster of the two full-document parsers benchmarked on that
 * exact shape.
 */
import { load, type CheerioAPI } from "cheerio";

export type { CheerioAPI };

/** Parse a document once and hand back the query root. */
export function parseHtml(html: string): CheerioAPI {
  return load(html);
}

/**
 * Strip tags to readable plain text, preserving block structure.
 *
 * Deliberately not a parse: this runs over description fields that are already
 * HTML fragments, thousands at a time, and the caller wants indexable text
 * rather than a DOM. Block-level tags become newlines first, so a stripped
 * list still reads as a list instead of collapsing into one line.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Absolutize a possibly-relative href against the page it was found on. */
export function absoluteUrl(href: string, pageUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return undefined;
  }
}
