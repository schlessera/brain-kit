/**
 * BuiltIn — remote jobs listing.
 *
 * Browser-only. The HTTP version of this adapter parsed JSON-LD out of the
 * markup and was disabled by default because the site answers a plain request
 * with a Cloudflare challenge; the working implementation lived in
 * `browser-scrape.ts`. That one survives, as an adapter.
 */
import { BrowserAdapter, type BrowserJobRecord } from "./browser-base.js";

const BASE_URL = "https://builtin.com/jobs/remote";
const PAGES = 3;

export class BuiltInAdapter extends BrowserAdapter {
  readonly source = "builtin" as const;
  readonly name = "BuiltIn";
  readonly tier = 2 as const;
  protected readonly readySelector = 'a[href*="/job/"]';

  protected urls(): string[] {
    return Array.from({ length: PAGES }, (_, page) =>
      page === 0 ? BASE_URL : `${BASE_URL}?page=${page}`
    );
  }

  /**
   * Runs INSIDE the page — closes over nothing, references nothing from this
   * module. The company name is found by scanning the card's visible lines for
   * the first one that is not the title and not obvious chrome; the site has
   * no stable company selector.
   *
   * The description comes from the page's own structured data: its `@graph`
   * holds an `ItemList` whose entries carry a URL and a description for every
   * card (#36). That is the one place Built In publishes it without a detail
   * page, and its detail pages sit behind the same challenge as its listing.
   */
  protected extract(): BrowserJobRecord[] {
    const jobs: BrowserJobRecord[] = [];
    const seen = new Set<string>();

    // Keyed without query, fragment or trailing slash, so a card linking
    // `…/11309150/?utm_source=…` still finds `…/11309150`.
    const key = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const descriptions = new Map<string, string>();
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data: unknown;
      try {
        data = JSON.parse(script.textContent || "");
      } catch {
        continue;
      }
      const nodes: unknown[] = [];
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(collect);
        if (!value || typeof value !== "object") return;
        nodes.push(value);
        const graph = (value as { "@graph"?: unknown })["@graph"];
        if (graph) collect(graph);
      };
      collect(data);
      for (const node of nodes) {
        const list = node as { "@type"?: unknown; itemListElement?: unknown };
        if (list["@type"] !== "ItemList" || !Array.isArray(list.itemListElement)) continue;
        for (const entry of list.itemListElement) {
          const item = (entry as { item?: unknown }).item ?? entry;
          const { url, description } = item as { url?: unknown; description?: unknown };
          if (typeof url === "string" && typeof description === "string" && description.trim()) {
            descriptions.set(key(url), description.trim());
          }
        }
      }
    }

    for (const link of document.querySelectorAll('a[href*="/job/"]')) {
      const href = link.getAttribute("href");
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const title = link.textContent?.trim();
      if (!title || title.length < 5 || title.length > 200) continue;

      const card =
        link.closest('[class*="job"], [class*="card"], article, li') ||
        link.parentElement?.parentElement?.parentElement;
      const lines = ((card as HTMLElement | null | undefined)?.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      let company = "";
      for (const line of lines) {
        if (line === title) continue;
        if (
          line.length > 2 &&
          line.length < 60 &&
          !line.match(/^(Remote|Hybrid|Apply|View|Save|Easy|\$|Posted|\d+ )/i)
        ) {
          company = line;
          break;
        }
      }

      const absolute = href.startsWith("http") ? href : `https://builtin.com${href}`;
      jobs.push({
        title,
        company,
        description: descriptions.get(key(absolute)),
        href: absolute,
        location: "Remote",
        remote_type: "fully_remote",
      });
    }
    return jobs;
  }
}
