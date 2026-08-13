/**
 * Shared HTML utilities for the job scraping subsystem.
 * Single canonical stripHtml — consolidated from the previous copies in
 * adapters/base.ts, scrape.ts, and browser-scrape.ts.
 */

/**
 * Extract and parse every JSON-LD block in a document.
 *
 * Boards routinely emit attributes on the script tag (Dice ships
 * `<script type="application/ld+json" data-testid="..." id="...">`), so the
 * tag pattern must tolerate them — matching only the bare `<script
 * type="application/ld+json">` form silently finds nothing. Arrays and
 * `@graph` containers are flattened so callers can just filter by `@type`.
 * Unparseable blocks are skipped rather than throwing: one malformed block
 * on a page should not cost us the rest.
 */
export function extractJsonLd(html: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const scriptRe =
    /<script[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      collectJsonLd(JSON.parse(raw), out);
    } catch {
      // Malformed block — skip it, keep scanning.
    }
  }
  return out;
}

function collectJsonLd(node: unknown, out: Array<Record<string, any>>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const entry of node) collectJsonLd(entry, out);
    return;
  }
  const obj = node as Record<string, any>;
  if (Array.isArray(obj["@graph"])) {
    for (const entry of obj["@graph"]) collectJsonLd(entry, out);
  }
  if (obj["@type"]) out.push(obj);
}

/**
 * Find the first JSON-LD node of a given `@type` (handles the array form of
 * `@type` that some boards emit).
 */
export function findJsonLdType(
  html: string,
  type: string
): Record<string, any> | null {
  for (const node of extractJsonLd(html)) {
    const t = node["@type"];
    if (t === type || (Array.isArray(t) && t.includes(type))) return node;
  }
  return null;
}

/**
 * Decode the HTML entities that survive in attribute values (titles, company
 * names). Deliberately narrower than stripHtml, which is for whole documents.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

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
