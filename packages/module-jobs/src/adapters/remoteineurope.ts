import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, stripHtml } from "../html.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// Webflow CMS site. It publishes no JSON-LD anywhere, but its collection items
// carry explicit CMS-filter attributes, which are far more reliable than the
// positional guessing the previous parser did:
//
//   <a href="/job/{slug}" class="card job w-inline-block">
//     <div fs-cmsfilter-field="company" ...>Wikimedia Foundation</div>
//     <h3 fs-cmsfilter-field="job-title" ...>Email Developer (Fundraising)</h3>
//     <div class="date-text-mobile">22 May</div>
//
// Stripping the whole anchor (the old approach) produced titles such as
// "Canonical 1 Apr Canonical Senior Design Researcher" — company and date
// folded into the title — and a company of "Unknown", or "Learn More" when it
// picked up the sponsored promo card.
const CATEGORY_URLS = [
  "https://remoteineurope.com/categories/programming",
  "https://remoteineurope.com/categories/devops-sysadmin",
  "https://remoteineurope.com/categories/product",
  "https://remoteineurope.com/categories/design",
];

const DETAIL_CONCURRENCY = 3;
const MAX_DETAILS_PER_RUN = 180;

interface RieListing {
  slug: string;
  title: string;
  company: string;
  date?: string;
  category?: string;
}

export class RemoteInEuropeAdapter extends BaseAdapter {
  readonly source = "remoteineurope" as const;
  readonly name = "Remote in Europe";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const listings = new Map<string, RieListing>();

    const urls = ["https://remoteineurope.com/", ...CATEGORY_URLS];

    for (const pageUrl of urls) {
      try {
        const category = pageUrl.endsWith("/") ? "all" : pageUrl.split("/").pop() || "all";
        if (opts.verbose) console.log(`[remoteineurope] Fetching: ${category}...`);

        const html = await httpGetText(pageUrl, { rateLimit: 2000, proxy: opts.proxy });

        for (const listing of this.parseListings(html, category)) {
          if (!listings.has(listing.slug)) listings.set(listing.slug, listing);
        }
      } catch (err) {
        errors.push(`RemoteInEurope ${pageUrl} failed: ${err}`);
      }
    }

    if (listings.size === 0) {
      errors.push("RemoteInEurope listings yielded 0 jobs — markup drift?");
      return this.makeResult([], errors);
    }

    let queue = [...listings.values()];
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `RemoteInEurope: capped detail fetches at ${MAX_DETAILS_PER_RUN}, ${dropped} job(s) kept without description`
      );
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }
    const listingOnly = [...listings.values()].slice(queue.length);

    if (opts.verbose) console.log(`[remoteineurope] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const detailed = await mapLimit(queue, DETAIL_CONCURRENCY, async (listing) => {
      const base = this.toRawJob(listing);
      try {
        const html = await httpGetText(this.jobUrl(listing.slug), {
          rateLimit: 250,
          proxy: opts.proxy,
        });
        const detail = this.parseDetail(html);
        if (detail.description) {
          enriched++;
          return { ...base, ...detail };
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

    if (enriched < queue.length) {
      errors.push(
        `RemoteInEurope: ${queue.length - enriched} of ${queue.length} job(s) stored without a description (detail fetch or markup failed)`
      );
    }

    if (opts.verbose) {
      console.log(`[remoteineurope] Total: ${jobs.length} jobs (${enriched} with description)`);
    }
    return this.makeResult(jobs, errors);
  }

  private parseListings(html: string, category: string): RieListing[] {
    const listings: RieListing[] = [];
    const seen = new Set<string>();

    // Only real collection items: the sponsored promo card uses href="#".
    const cardRe = /<a[^>]*href="\/job\/([a-z0-9-]+)"[^>]*class="[^"]*card job[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = cardRe.exec(html)) !== null) {
      const [, slug, card] = match;
      if (!slug || seen.has(slug)) continue;

      const titleMatch = card.match(
        /<[^>]*fs-cmsfilter-field="job-title"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i
      );
      const title = titleMatch ? decodeEntities(stripHtml(titleMatch[1])) : "";
      if (!title || title.length < 3) continue;
      seen.add(slug);

      const companyMatch = card.match(
        /<[^>]*fs-cmsfilter-field="company"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i
      );
      const company = companyMatch
        ? decodeEntities(stripHtml(companyMatch[1])) || "Unknown"
        : "Unknown";

      const dateMatch = card.match(/<div[^>]*class="[^"]*date-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const date = dateMatch ? decodeEntities(stripHtml(dateMatch[1])) : undefined;

      listings.push({
        slug,
        title,
        company,
        date,
        category: category !== "all" ? category : undefined,
      });
    }

    return listings;
  }

  /** Description and location live in the Webflow rich-text block. */
  private parseDetail(html: string): Partial<RawJob> {
    const out: Partial<RawJob> = {};

    const rich = html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (rich && stripHtml(rich[1]).length > 80) out.description = rich[1].trim();

    const location = html.match(/<div[^>]*class="[^"]*label-location[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (location) {
      const text = decodeEntities(stripHtml(location[1]));
      if (text) out.location = text;
    }

    return out;
  }

  private jobUrl(slug: string): string {
    return `https://remoteineurope.com/job/${slug}`;
  }

  /**
   * Parse the listing's "22 May" style date into an ISO timestamp. A year-less
   * date means the most recent past occurrence, so a date that lands in the
   * future belongs to last year.
   */
  private parseListingDate(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const match = raw.match(
      /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{4})?)/i
    );
    if (!match) return undefined;

    const text = match[1];
    const hasYear = /\d{4}/.test(text);
    const currentYear = new Date().getFullYear();
    let parsed = new Date(hasYear ? text : `${text} ${currentYear}`);
    if (Number.isNaN(parsed.getTime())) return undefined;

    const graceMs = 7 * 24 * 60 * 60 * 1000;
    if (!hasYear && parsed.getTime() - Date.now() > graceMs) {
      parsed = new Date(`${text} ${currentYear - 1}`);
      if (Number.isNaN(parsed.getTime())) return undefined;
    }
    return parsed.toISOString();
  }

  private toRawJob(listing: RieListing): RawJob {
    // source_id keeps the bare slug, matching rows already in the database.
    return {
      source: "remoteineurope",
      source_id: listing.slug,
      title: listing.title,
      company: listing.company,
      url: this.jobUrl(listing.slug),
      source_url: this.jobUrl(listing.slug),
      location: "Europe (Remote)",
      remote_type: "fully_remote",
      job_type: "full_time",
      category: listing.category,
      published_at: this.parseListingDate(listing.date),
    };
  }
}
