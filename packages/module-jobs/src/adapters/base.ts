import type { ScraperAdapter, ScrapeOptions, ScrapeResult, RawJob, Source } from "../types";
import { stripHtml } from "../html";

export abstract class BaseAdapter implements ScraperAdapter {
  abstract readonly source: Source;
  abstract readonly name: string;
  abstract readonly tier: 1 | 2 | 3;
  needsBrowser = false;
  needsProxy = false;

  abstract scrape(opts: ScrapeOptions & { lastCursor?: string }): Promise<ScrapeResult>;

  protected stripHtml(html: string): string {
    return stripHtml(html);
  }

  protected parseRssItems(xml: string): Array<Record<string, string>> {
    const items: Array<Record<string, string>> = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const item: Record<string, string> = {};

      // Extract standard and namespaced tags
      const tagRegex = /<(\w[\w:-]*?)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
      let tagMatch: RegExpExecArray | null;

      while ((tagMatch = tagRegex.exec(itemXml)) !== null) {
        const tagName = tagMatch[1].replace(":", "_"); // e.g. dc:creator -> dc_creator
        let value = tagMatch[2].trim();
        // Handle CDATA
        const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
        if (cdataMatch) value = cdataMatch[1];
        item[tagName] = value;
      }

      // Extract self-closing tags with url attribute (e.g. media:content)
      const selfClosingRegex = /<([\w:-]+)\s+([^>]*?)\/>/g;
      let scMatch: RegExpExecArray | null;
      while ((scMatch = selfClosingRegex.exec(itemXml)) !== null) {
        const tagName = scMatch[1].replace(":", "_");
        const attrs = scMatch[2];
        const urlMatch = attrs.match(/url="([^"]+)"/);
        if (urlMatch) item[`${tagName}_url`] = urlMatch[1];
      }

      items.push(item);
    }
    return items;
  }

  protected makeResult(jobs: RawJob[], errors: string[], cursor?: string): ScrapeResult {
    return { source: this.source, jobs, errors, cursor };
  }
}
