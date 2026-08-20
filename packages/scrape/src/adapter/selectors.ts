/**
 * Config-driven extraction: a site described as data instead of as code.
 *
 * The scrapers this replaces embedded per-site CSS selectors as JavaScript
 * string literals inside a published npm package. When a site changed its
 * markup — which is the normal, expected thing for a site to do — the fix
 * required a source edit, a release, and every consumer upgrading. The
 * selectors were the most volatile thing in the package and shipped in the
 * least changeable place.
 *
 * A `SiteSelectors` is plain data. It can come from a module's config file, so
 * a broken selector is something a user fixes in the afternoon.
 */
import type { CheerioAPI } from "../parse/html.js";
import { absoluteUrl } from "../parse/html.js";

/** How to read one field out of a card. */
export interface FieldSelector {
  /** CSS selector, relative to the card. Omit to read the card itself. */
  selector?: string;
  /** Attribute to read. Omit for the element's text. */
  attr?: string;
  /** Resolve the value against the page URL (for `href`/`src`). */
  absolute?: boolean;
  /**
   * Take the first non-empty candidate. Useful where a site uses one of two
   * layouts and neither is reliably present.
   */
  fallbacks?: Array<Omit<FieldSelector, "fallbacks">>;
}

/** How to find and read the repeating unit on a listing page. */
export interface SiteSelectors {
  /** Selector matching each card/row on the page. */
  card: string;
  /** Await this before extracting, on browser-rendered pages. */
  readySelector?: string;
  /** Fields to read from each card, keyed by output field name. */
  fields: Record<string, FieldSelector>;
  /** Cards missing any of these field names are dropped as incomplete. */
  required?: string[];
}

function readOne(
  card: any,
  field: Omit<FieldSelector, "fallbacks">,
  pageUrl: string
): string | undefined {
  const el = field.selector ? card.find(field.selector).first() : card;
  if (!el || el.length === 0) return undefined;
  const raw = field.attr ? el.attr(field.attr) : el.text();
  const value = raw?.trim();
  if (!value) return undefined;
  return field.absolute ? absoluteUrl(value, pageUrl) : value;
}

/** Read one field, trying its fallbacks in order. */
export function readField(
  card: any,
  field: FieldSelector,
  pageUrl: string
): string | undefined {
  const direct = readOne(card, field, pageUrl);
  if (direct !== undefined) return direct;
  for (const fallback of field.fallbacks ?? []) {
    const value = readOne(card, fallback, pageUrl);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Apply a selector set to a page, yielding one flat record per card.
 *
 * Cards missing a required field are dropped rather than emitted half-empty —
 * a half-parsed record downstream is worse than a missing one, because it
 * looks like data.
 */
export function extractCards(
  $: CheerioAPI,
  selectors: SiteSelectors,
  pageUrl: string
): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];

  $(selectors.card).each((_i, element) => {
    const card = $(element);
    const record: Record<string, string> = {};
    for (const [name, field] of Object.entries(selectors.fields)) {
      const value = readField(card, field, pageUrl);
      if (value !== undefined) record[name] = value;
    }
    const missing = (selectors.required ?? []).filter((name) => !record[name]);
    if (missing.length === 0) records.push(record);
  });

  return records;
}
