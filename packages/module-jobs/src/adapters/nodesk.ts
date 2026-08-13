import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, findJsonLdType, stripHtml } from "../html.js";
import { applyJobPosting } from "../jsonld-job.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// NoDesk serves minified HTML with *unquoted* attribute values
// (`href=/remote-jobs/acme-engineer/`). Patterns written against the quoted
// form match nothing, which is how this adapter came to report a silent zero.
// Every attribute pattern below therefore accepts quoted or bare values.
//
// Listing card shape:
//   <h2 ...><a class="..." href=/remote-jobs/{slug}/>Title</a></h2>
//   <h3 ...><a class="..." href=/remote-companies/{slug}/>Company</a></h3>
//   <h4>Remote:</h4><h5><a href=/remote-jobs/{region}/>Region</a></h5>
const BASE_URL = "https://nodesk.co/remote-jobs/";

const DETAIL_CONCURRENCY = 3;
const MAX_DETAILS_PER_RUN = 100;

// Category and region slugs live under the same /remote-jobs/ prefix as real
// postings, so they have to be filtered out by name.
const NON_JOB_SLUGS = new Set([
  "ai", "account-executive", "accounting", "collections", "customer-support",
  "design", "development", "engineering", "entry-level", "finance", "hr",
  "human-resources", "marketing", "new", "non-tech", "operations", "other",
  "part-time", "product", "project-management", "recruiting", "sales",
  "software-development", "support", "writing",
  // Regions
  "africa", "americas", "anywhere", "asia", "australia", "canada", "emea",
  "europe", "latin-america", "north-america", "oceania", "uk", "usa",
  "worldwide",
]);

interface NodeskListing {
  slug: string;
  title: string;
  company: string;
  location: string;
}

export class NodeskAdapter extends BaseAdapter {
  readonly source = "nodesk" as const;
  readonly name = "Nodesk";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];

    let html: string;
    try {
      if (opts.verbose) console.log("[nodesk] Fetching remote jobs page...");
      html = await httpGetText(BASE_URL, { rateLimit: 2000, proxy: opts.proxy });
    } catch (err) {
      return this.makeResult([], [`Nodesk fetch failed: ${err}`]);
    }

    const listings = this.parseListings(html);
    if (listings.length === 0) {
      return this.makeResult([], ["Nodesk listing page yielded 0 jobs — markup drift?"]);
    }

    let queue = listings;
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `Nodesk: capped detail fetches at ${MAX_DETAILS_PER_RUN}, ${dropped} job(s) kept without description`
      );
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }
    const listingOnly = listings.slice(queue.length);

    if (opts.verbose) console.log(`[nodesk] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const detailed = await mapLimit(queue, DETAIL_CONCURRENCY, async (listing) => {
      const base = this.toRawJob(listing);
      try {
        const detailHtml = await httpGetText(this.jobUrl(listing.slug), {
          rateLimit: 250,
          proxy: opts.proxy,
        });
        const posting = findJsonLdType(detailHtml, "JobPosting");
        if (posting) {
          enriched++;
          return applyJobPosting(base, posting);
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

    // Losing the description silently would put the job back into the
    // title-only scoring path that this change exists to eliminate.
    if (enriched < queue.length) {
      errors.push(
        `Nodesk: ${queue.length - enriched} of ${queue.length} job(s) stored without a description (detail fetch or JobPosting missing)`
      );
    }

    if (opts.verbose) console.log(`[nodesk] Found ${jobs.length} jobs (${enriched} with description)`);
    return this.makeResult(jobs, errors);
  }

  private parseListings(html: string): NodeskListing[] {
    const listings: NodeskListing[] = [];
    const seen = new Set<string>();

    // Title anchors sit inside an <h2>; attribute values may be unquoted.
    const titleRe =
      /<h2[^>]*>\s*<a[^>]*href=["']?\/remote-jobs\/([a-z0-9-]+)\/?["']?[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = titleRe.exec(html)) !== null) {
      const [, slug, titleHtml] = match;
      if (!slug || seen.has(slug) || NON_JOB_SLUGS.has(slug)) continue;

      const title = decodeEntities(stripHtml(titleHtml));
      if (!title || title.length < 3) continue;
      seen.add(slug);

      // Company and location follow the title within the same card.
      const tail = html.slice(match.index, match.index + 1600);

      const companyMatch = tail.match(
        /<a[^>]*href=["']?\/remote-companies\/[a-z0-9-]+\/?["']?[^>]*>([\s\S]*?)<\/a>/i
      );
      const company = companyMatch
        ? decodeEntities(stripHtml(companyMatch[1])) || "Unknown"
        : "Unknown";

      const locationMatch = tail.match(
        /Remote:\s*<\/h4>[\s\S]{0,200}?<a[^>]*>([\s\S]*?)<\/a>/i
      );
      const location = locationMatch
        ? decodeEntities(stripHtml(locationMatch[1])) || "Remote"
        : "Remote";

      listings.push({ slug, title, company, location });
    }

    return listings;
  }

  private jobUrl(slug: string): string {
    return `https://nodesk.co/remote-jobs/${slug}/`;
  }

  private toRawJob(listing: NodeskListing): RawJob {
    // source_id keeps the historical absolute-URL shape so existing rows
    // continue to match instead of being re-inserted as new jobs.
    return {
      source: "nodesk",
      source_id: this.jobUrl(listing.slug),
      title: listing.title,
      company: listing.company,
      url: this.jobUrl(listing.slug),
      source_url: this.jobUrl(listing.slug),
      location: listing.location,
      remote_type: "fully_remote",
      job_type: "full_time",
    };
  }

}
