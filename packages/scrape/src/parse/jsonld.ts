/**
 * JSON-LD out of a page, with no idea what the JSON-LD is about.
 *
 * Structured data is the difference between parsing a job and parsing a page
 * that happens to contain one, and it survives redesigns that break every CSS
 * selector pointed at the same page. So this is a parsing primitive, next to
 * `parseHtml` and `parseRssItems` — `JobPosting`, `Recipe` and `Product` are
 * all the consuming module's business.
 *
 * Regex rather than a DOM walk, for the same reason `parse/feed.ts` is: this
 * runs over whole listing pages before anything else looks at them, and the
 * thing being matched is one script element whose body is opaque to the HTML
 * parser anyway.
 *
 * What the regex has to tolerate is the whole point. The pattern this replaces
 * required a BARE tag — `<script type="application/ld+json">`, nothing else
 * between the type and the `>`. Measured against real boards on 2026-09-22,
 * that misses most of them: remotely.de writes `id="collection-page-jsonld"`
 * first, Dice appends `data-testid`, SimplyHired appends `data-next-head`, and
 * NoDesk does not quote the attribute value at all.
 */

/** One object in a JSON-LD document. */
export type JsonLdNode = Record<string, unknown>;

export interface JsonLdExtraction {
  /**
   * One entry per `application/ld+json` script that parsed, in document order.
   * A document is whatever the page served: an object, an array, a `@graph`.
   */
  documents: unknown[];
  /**
   * One message per script whose body did not parse. Extraction never throws:
   * one malformed tag on a page costs that tag's rows and nothing else.
   */
  errors: string[];
}

/**
 * Every `<script>` on the page, with its attributes and its body.
 *
 * `[^>]*` for the attribute blob is the same bet `stripHtml` makes: a `>`
 * inside an attribute value would cut the match short. Real pages put JSON-LD
 * in a script whose attributes are an id, a type and a test hook.
 */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * The script's `type`, quoted, single-quoted or bare.
 *
 * Anchored on a boundary that is NOT a name character, so `data-type="…"` —
 * which Remote OK serves on the script beside its JSON-LD — cannot be read as
 * this element's type.
 */
const TYPE_ATTR_RE = /(?:^|[\s/])type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** `application/ld+json`, with or without the parameters a charset adds. */
const LD_JSON_RE = /^application\/ld\+json\s*(?:;|$)/i;

/**
 * Parse every JSON-LD script in a page.
 *
 * An empty tag is not an error — pages ship placeholders their own JavaScript
 * fills in later, and reporting one per page would bury the malformed body
 * that actually cost someone a row.
 */
export function extractJsonLd(html: string): JsonLdExtraction {
  const documents: unknown[] = [];
  const errors: string[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  SCRIPT_RE.lastIndex = 0;
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    const typeMatch = match[1].match(TYPE_ATTR_RE);
    if (!typeMatch) continue;
    const type = (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3] ?? "").trim();
    if (!LD_JSON_RE.test(type)) continue;

    index += 1;
    const body = match[2].trim();
    if (!body) continue;

    try {
      documents.push(JSON.parse(body));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`JSON-LD script ${index} did not parse: ${reason}`);
    }
  }

  return { documents, errors };
}

/** How deep the node walk goes before it stops looking. */
const MAX_DEPTH = 12;

/**
 * Every object reachable in a parsed document, in document order.
 *
 * The four shapes a caller has to survive are all the same walk: a bare node,
 * an array of nodes, a `@graph` wrapper, and a node nested inside another one
 * (`CollectionPage` → `mainEntity` → `ItemList` → `ListItem` → `item`, which
 * is what remotely.de serves). Descending into every value rather than a
 * known list of keys means a posting still gets found when a site wraps it in
 * a container nobody has seen yet, and the caller selects by `@type` anyway.
 */
export function jsonLdNodes(value: unknown, depth: number = 0): JsonLdNode[] {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => jsonLdNodes(entry, depth + 1));
  }

  const node = value as JsonLdNode;
  const nodes: JsonLdNode[] = [node];
  for (const [key, child] of Object.entries(node)) {
    // Keywords are metadata, not nodes — except `@graph`, which is a list of
    // them. `@context` in particular can be an object of term definitions.
    if (key.startsWith("@") && key !== "@graph") continue;
    nodes.push(...jsonLdNodes(child, depth + 1));
  }
  return nodes;
}

/** A node's `@type`s. Schema.org allows one or several. */
export function jsonLdTypes(node: JsonLdNode): string[] {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/** Does this node carry `type` among its `@type`s? Compared case-insensitively. */
export function hasJsonLdType(node: JsonLdNode, type: string): boolean {
  return jsonLdTypes(node).some((candidate) => candidate.toLowerCase() === type.toLowerCase());
}

/** Every node of one `@type` anywhere in the given documents. */
export function jsonLdByType(value: unknown, type: string): JsonLdNode[] {
  return jsonLdNodes(value).filter((node) => hasJsonLdType(node, type));
}

/**
 * The entries of an `ItemList`, with `ListItem` wrappers removed.
 *
 * Both forms are in the wild and a caller cannot tell them apart usefully:
 * Built In writes the payload ON the `ListItem` (`name`, `url`,
 * `description`), remotely.de writes a `ListItem` whose `item` holds it.
 * Neither says `JobPosting`, which is why a mapper that insists on that type
 * reads a populated list as an empty one.
 *
 * An `item` that is a bare string — a URL, as Jobgether's breadcrumbs write it
 * — carries nothing to map, so it is dropped rather than returned as an empty
 * node.
 */
export function itemListEntries(node: JsonLdNode): JsonLdNode[] {
  const raw = node.itemListElement;
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: JsonLdNode[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const listItem = entry as JsonLdNode;
    const inner = listItem.item;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      out.push(inner as JsonLdNode);
      continue;
    }
    if (inner === undefined) out.push(listItem);
  }
  return out;
}
