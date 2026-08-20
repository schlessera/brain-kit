/**
 * RSS/Atom item extraction.
 *
 * Ported from the regex implementation that lived on `module-jobs`'s
 * `BaseAdapter`, where every adapter inherited it whether it consumed feeds or
 * not. It stays regex-based rather than becoming an XML parse: feeds in the
 * wild are frequently not well-formed, and a strict parser fails the whole
 * document over one unescaped ampersand in one item. Being lenient per-item is
 * the right trade for this input.
 *
 * Namespaced tags are flattened with an underscore (`dc:creator` →
 * `dc_creator`), so a caller reads one flat record per item.
 */

/** One feed item, as a flat map of tag name to text content. */
export type FeedItem = Record<string, string>;

/** Unwrap a CDATA section, if the value is one. */
function unwrapCdata(value: string): string {
  const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : value;
}

/**
 * Extract `<item>` elements from an RSS document.
 *
 * Self-closing tags carrying a `url` attribute (`<media:content url="…"/>`,
 * `<enclosure url="…"/>`) are surfaced as `<tag>_url`, since that is the only
 * part of them anyone reads.
 */
export function parseRssItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const item: FeedItem = {};

    const tagRegex = /<(\w[\w:-]*?)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(itemXml)) !== null) {
      item[tagMatch[1].replace(":", "_")] = unwrapCdata(tagMatch[2].trim());
    }

    const selfClosingRegex = /<([\w:-]+)\s+([^>]*?)\/>/g;
    let scMatch: RegExpExecArray | null;
    while ((scMatch = selfClosingRegex.exec(itemXml)) !== null) {
      const urlMatch = scMatch[2].match(/url="([^"]+)"/);
      if (urlMatch) item[`${scMatch[1].replace(":", "_")}_url`] = urlMatch[1];
    }

    items.push(item);
  }
  return items;
}
