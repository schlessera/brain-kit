import { parseHtml } from "@schlessera/brain-scrape";

import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

/**
 * remotely.de, parsed from the job cards its listing actually renders.
 *
 * Three things this adapter used to get wrong, all measured in #33:
 *
 * - it fetched the apex, which 301s to `www`;
 * - it paged with `?page=N`, which 308s to `/remote-jobs/seite/N`;
 * - when its JSON-LD path found nothing — which is always, because the script
 *   tag is not bare and its `ListItem`s carry only `@id` and `name` — it fell
 *   back to scanning `href="/remote-jobs/<slug>"`, which is the site's own
 *   category navigation. Every stored row was a category link with the
 *   company `Unknown`, and nothing reported an error.
 *
 * Real postings are `/job/<slug>`, and the card carries the company. There are
 * two card layouts: a featured one that puts the company in a span beside the
 * logo and adds a description teaser, and the ordinary row, whose meta line
 * reads `<company> · <location>`. Both are handled; the listing has no
 * employment type, so `job_type` is left for the runner to record as unknown.
 *
 * The description a card can offer is a five-line teaser and only the featured
 * layout has one. A full description needs the detail page (#36).
 */
const ORIGIN = "https://www.remotely.de";
const LISTING_PATH = "/remote-jobs";
const PAGES_TO_FETCH = 5;

/** Badges in the card's meta row that describe remoteness, not a place. */
const REMOTE_BADGE = /^(vollständig remote|remote first|hybrid)$/i;

/** One page's worth of cards, plus what could not be read off them. */
interface PageParse {
  jobs: RawJob[];
  /** Cards dropped because a required field was absent, counted per field. */
  missing: { title: number; company: number };
}

export class RemotelyDeAdapter extends BaseAdapter {
  readonly source = "remotelyde" as const;
  readonly name = "Remotely.de";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const pages = this.ledger();
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();

    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      const url = page === 1 ? `${ORIGIN}${LISTING_PATH}` : `${ORIGIN}${LISTING_PATH}/seite/${page}`;
      try {
        if (opts.verbose) console.log(`[remotelyde] Fetching page ${page}...`);

        const fetched = await this.http.getPage(url, {
          delayMs: 2000,
          proxy: opts.proxy,
        });

        const { jobs, missing } = this.parseCards(fetched.body);
        for (const [field, count] of Object.entries(missing)) {
          if (count > 0) {
            pages.note(`remotely.de page ${page}: ${count} card(s) carried no ${field}`);
          }
        }
        // Page 1 is the listing; 2..5 exist only because the page before them
        // parsed, so nothing on one of those is the end of the list rather
        // than a parser that has stopped working. Page 1 gets no such excuse:
        // there is no captured no-results markup for this board, so a served
        // first page with no cards on it is reported as drift.
        pages.read(url, jobs.length, { continuation: page > 1, from: fetched.url });
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[remotelyde] Page ${page}: ${jobs.length} jobs`);
      } catch (err) {
        pages.unreachable(url, err);
      }
    }

    if (opts.verbose) console.log(`[remotelyde] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, pages);
  }

  /**
   * Read the `/job/<slug>` cards off a listing page.
   *
   * Anchored on the job URL shape rather than on a card class, so the site's
   * category navigation — `/remote-jobs/<slug>`, which is what used to be
   * stored — cannot match however the cards are restyled.
   */
  private parseCards(html: string): PageParse {
    const $ = parseHtml(html);
    const jobs: RawJob[] = [];
    const missing = { title: 0, company: 0 };
    const seen = new Set<string>();

    $('a[href^="/job/"]').each((_i, element) => {
      const card = $(element);
      const href = card.attr("href");
      if (!href) return;
      const slug = href.slice("/job/".length);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = card.find("h3").first().text().trim() || (card.attr("aria-label") ?? "").trim();

      // Row layout: "<company> · <location> · …". Featured layout: the company
      // sits beside the logo and the location is left to the badge row.
      //
      // The meta line keeps its empty pieces until the company has been taken
      // off the front: dropping them first would promote the location into the
      // company slot on a card whose company is blank, which is the "Unknown"
      // failure wearing a different name.
      const metaParts = splitOnMiddot(card.find("p.truncate").first().text());
      const badgeParts = splitOnMiddot(
        card
          .find("span.text-accent-search")
          .map((_j, badge) => $(badge).text())
          .get()
          .join(" · ")
      ).filter(Boolean);
      const company = card.find("span.truncate").first().text().trim() || (metaParts.shift() ?? "");

      if (!title) missing.title++;
      if (!company) missing.company++;
      if (!title || !company) return;

      const locationParts = [
        ...metaParts.filter(Boolean),
        ...badgeParts.filter((part) => !REMOTE_BADGE.test(part)),
      ];
      const description = card.find("p.line-clamp-5").first().text().trim();
      const url = `${ORIGIN}${href}`;

      jobs.push({
        source: "remotelyde",
        source_id: slug,
        title,
        company,
        description: description || undefined,
        url,
        source_url: url,
        location: locationParts.join(", ") || "Germany (Remote)",
        remote_type: badgeParts.some((part) => /hybrid/i.test(part)) ? "hybrid" : "fully_remote",
      });
    });

    return { jobs, missing };
  }
}

/** Split a card's meta line on its middot separator. Empty pieces are kept. */
function splitOnMiddot(text: string): string[] {
  return text.split("·").map((part) => part.trim());
}
