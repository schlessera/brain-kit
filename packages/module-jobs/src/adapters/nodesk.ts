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
  /** Its job pages, which detail-page enrichment may follow (#36). */
  override readonly detailHosts = ["nodesk.co"];
  /**
   * The title link of an Algolia hit card, not any `/remote-jobs/` link: the
   * page's navigation carries category links under the same path, and they
   * render before the hits do (#277).
   */
  protected readonly readySelector = 'li.ais-Hits-item h2 a[href^="/remote-jobs/"]';

  protected urls(): string[] {
    return [LISTING_URL];
  }

  /**
   * Runs INSIDE the page. `/remote-jobs/<slug>` is used for postings,
   * categories and every filter link inside a card (location, role, job
   * type), so no slug shape tells them apart: `full-time-remote` and
   * `blockchain-cryptocurrency-jobs` look like postings (#277). The posting is
   * the one link in a hit card's title, so that is the only link read. The
   * selector repeats `readySelector` because this function closes over
   * nothing.
   */
  protected extract(): BrowserJobRecord[] {
    const jobs: BrowserJobRecord[] = [];
    const seen = new Set<string>();

    for (const link of document.querySelectorAll('li.ais-Hits-item h2 a[href^="/remote-jobs/"]')) {
      const href = link.getAttribute("href") || "";
      const slug = href.replace("/remote-jobs/", "").replace(/\/$/, "");
      if (!slug || slug.includes("/") || seen.has(href)) continue;
      seen.add(href);

      const title = link.textContent?.trim();
      if (!title || title.length < 5) continue;

      // The hit card is the whole container: a walk upward from the link
      // reached neighbouring cards and promoted blocks, and stored their
      // company on this row. The company is the card's heading, not a link
      // (#320).
      const card = link.closest("li.ais-Hits-item");
      const company = card?.querySelector("h3")?.textContent?.trim() || "";
      const text = card?.textContent || "";
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
