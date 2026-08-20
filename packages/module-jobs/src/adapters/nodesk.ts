/**
 * NoDesk — remote jobs listing.
 *
 * Browser-only: the listing is client-rendered, so the HTTP adapter that used
 * to live here saw an empty shell. Replaced by the `browser-scrape.ts`
 * implementation, now an adapter like everything else.
 */
import { BrowserAdapter, type BrowserJobRecord } from "./browser-base.js";

const LISTING_URL = "https://nodesk.co/remote-jobs/";

export class NodeskAdapter extends BrowserAdapter {
  readonly source = "nodesk" as const;
  readonly name = "NoDesk";
  readonly tier = 2 as const;
  protected readonly readySelector = 'a[href^="/remote-jobs/"]';

  protected urls(): string[] {
    return [LISTING_URL];
  }

  /**
   * Runs INSIDE the page. `/remote-jobs/<slug>` is used for both postings and
   * category pages, so the slug shape is the filter: a real posting's slug has
   * at least three hyphenated parts and is not one of the known category
   * names.
   */
  protected extract(): BrowserJobRecord[] {
    const jobs: BrowserJobRecord[] = [];
    const seen = new Set<string>();
    const skipPaths = [
      "collections",
      "new",
      "customer-support",
      "design",
      "engineering",
      "marketing",
      "non-tech",
      "operations",
      "product",
      "sales",
      "entry-level",
      "other",
    ];

    for (const link of document.querySelectorAll('a[href^="/remote-jobs/"]')) {
      const href = link.getAttribute("href") || "";
      if (seen.has(href) || href === "/remote-jobs/") continue;

      const slug = href.replace("/remote-jobs/", "").replace(/\/$/, "");
      if (!slug || slug.includes("/") || skipPaths.includes(slug)) continue;
      if (slug.split("-").length < 3) continue;
      seen.add(href);

      const title = link.textContent?.trim();
      if (!title || title.length < 5) continue;

      // Walk up until the container holds enough text to be the whole card.
      let container = link.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        if ((container.textContent?.length || 0) > 100) break;
        container = container.parentElement;
      }

      const company =
        container?.querySelector('a[href*="/remote-companies/"]')?.textContent?.trim() || "";
      const text = container?.textContent || "";
      const locMatch = text.match(
        /Remote:\s*(.*?)(?:\n|Engineering|Design|Marketing|Sales|Product|Customer|Non|Operations|Other)/s
      );

      jobs.push({
        title,
        company,
        href: `https://nodesk.co${href}`,
        location: locMatch ? locMatch[1].replace(/[·]/g, ",").trim() : "Remote",
        remote_type: "fully_remote",
      });
    }
    return jobs;
  }
}
