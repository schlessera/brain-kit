import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, stripHtml } from "../html.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// Built In no longer ships JSON-LD on either the listing or the detail pages
// (the previous ItemList/CollectionPage parse path is dead), and job URLs moved
// from /jobs/remote/{slug} to /job/{slug}/{id}. What it does emit reliably are
// stable `data-id` hooks on the result cards:
//
//   <a href="/company/{slug}" data-id="company-title"><span>Company</span></a>
//   <a href="/job/{slug}/{id}" data-id="job-card-title">Title</a>
//
// Descriptions live only on the detail page, inside `.html-parsed-content`.
const BASE_URL = "https://builtin.com/jobs/remote";
const PAGES_TO_FETCH = 5;

const DETAIL_CONCURRENCY = 3;
const MAX_DETAILS_PER_RUN = 120;

interface BuiltInListing {
  id: string;
  href: string;
  title: string;
  company: string;
}

export class BuiltInAdapter extends BaseAdapter {
  readonly source = "builtin" as const;
  readonly name = "BuiltIn";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const listings = new Map<string, BuiltInListing>();

    for (let page = 0; page < PAGES_TO_FETCH; page++) {
      try {
        const url = page === 0 ? BASE_URL : `${BASE_URL}?page=${page}`;
        if (opts.verbose) console.log(`[builtin] Fetching page ${page}...`);

        const html = await httpGetText(url, { rateLimit: 2000, proxy: opts.proxy });
        const pageListings = this.parseListings(html);
        if (pageListings.length === 0) break; // no more pages

        for (const listing of pageListings) {
          if (!listings.has(listing.id)) listings.set(listing.id, listing);
        }
      } catch (err) {
        errors.push(`BuiltIn page ${page} failed: ${err}`);
        break;
      }
    }

    if (listings.size === 0) {
      errors.push("BuiltIn listing pages yielded 0 jobs — markup drift?");
      return this.makeResult([], errors);
    }

    let queue = [...listings.values()];
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `BuiltIn: capped detail fetches at ${MAX_DETAILS_PER_RUN}, ${dropped} job(s) kept without description`
      );
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }
    const listingOnly = [...listings.values()].slice(queue.length);

    if (opts.verbose) console.log(`[builtin] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const detailed = await mapLimit(queue, DETAIL_CONCURRENCY, async (listing) => {
      const base = this.toRawJob(listing);
      try {
        const html = await httpGetText(this.jobUrl(listing.href), {
          rateLimit: 250,
          proxy: opts.proxy,
        });
        const description = this.extractDescription(html);
        if (description) {
          enriched++;
          return { ...base, description };
        }
      } catch {
        // Keep the listing-level record.
      }
      return base;
    });

    const jobs = [
      ...detailed.filter((j): j is RawJob => j !== null),
      ...listingOnly.map((l) => this.toRawJob(l)),
    ];

    // A detail fetch that 403s, or markup that no longer yields a description,
    // must not pass as a clean run: without this the job is stored description-
    // less and scored on its title alone, which is the exact failure this
    // change exists to eliminate.
    if (enriched < queue.length) {
      errors.push(
        `BuiltIn: ${queue.length - enriched} of ${queue.length} job(s) stored without a description (detail fetch or markup failed)`
      );
    }

    if (opts.verbose) console.log(`[builtin] Found ${jobs.length} jobs (${enriched} with description)`);
    return this.makeResult(jobs, errors);
  }

  private parseListings(html: string): BuiltInListing[] {
    const listings: BuiltInListing[] = [];
    const seen = new Set<string>();

    const titleRe =
      /<a[^>]*href="(\/job\/[^"#?]+?\/(\d+))"[^>]*data-id="job-card-title"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = titleRe.exec(html)) !== null) {
      const [, href, id, titleHtml] = match;
      if (!id || seen.has(id)) continue;

      const title = decodeEntities(stripHtml(titleHtml));
      if (!title) continue;
      seen.add(id);

      listings.push({
        id,
        href,
        title,
        company: this.findCompany(html, match.index, id),
      });
    }

    return listings;
  }

  /**
   * The company anchor precedes its job-title anchor inside the same card, so
   * scan backwards from the title for the nearest `data-id="company-title"`.
   * Built In also stamps the job id on the company link, which disambiguates
   * when cards are adjacent.
   */
  private findCompany(html: string, titleIndex: number, jobId: string): string {
    const windowStart = Math.max(0, titleIndex - 2000);
    const before = html.slice(windowStart, titleIndex);

    const tagged = new RegExp(
      `data-id="company-title"[^>]*data-builtin-track-job-id="${jobId}"[^>]*>([\\s\\S]*?)</a>`,
      "i"
    ).exec(before);
    if (tagged) {
      const name = decodeEntities(stripHtml(tagged[1]));
      if (name) return name;
    }

    const anchors = [...before.matchAll(/data-id="company-title"[^>]*>([\s\S]*?)<\/a>/gi)];
    if (anchors.length > 0) {
      const name = decodeEntities(stripHtml(anchors[anchors.length - 1][1]));
      if (name) return name;
    }

    return "Unknown";
  }

  private extractDescription(html: string): string | undefined {
    const match = html.match(
      /<div[^>]*class="[^"]*html-parsed-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<button|<div[^>]*class="[^"]*show-more)/i
    );
    if (match) {
      const text = stripHtml(match[1]);
      if (text.length > 80) return match[1].trim();
    }

    // Fall back to the meta description — thin, but better than nothing.
    const meta = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
    return meta ? decodeEntities(meta[1]) : undefined;
  }

  private jobUrl(href: string): string {
    return href.startsWith("http") ? href : `https://builtin.com${href}`;
  }

  private toRawJob(listing: BuiltInListing): RawJob {
    const url = this.jobUrl(listing.href);
    // source_id stays the full URL, matching rows already in the database.
    return {
      source: "builtin",
      source_id: url,
      title: listing.title,
      company: listing.company,
      url,
      source_url: url,
      location: "Remote",
      remote_type: "fully_remote",
      job_type: "full_time",
    };
  }
}
