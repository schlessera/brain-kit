import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, findJsonLdType } from "../html.js";
import { applyJobPosting } from "../jsonld-job.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// Dice search pages list jobs but carry no per-job detail: no description, and
// the company name only appears as positional text inside the result card. The
// detail pages, by contrast, ship a complete schema.org JobPosting block. So
// the search page is used purely to enumerate job IDs, and every field that
// matters is read from the detail page.
//
// Neutral default search terms — override via the module `queries` config.
const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

const DETAIL_CONCURRENCY = 4;
// Ceiling on detail fetches per run, so a broad query set cannot turn into a
// thousand requests. Truncation is logged, never silent.
const MAX_DETAILS_PER_RUN = 150;

interface DiceListing {
  id: string;
  title: string;
  url: string;
}

export class DiceAdapter extends BaseAdapter {
  readonly source = "dice" as const;
  readonly name = "Dice";
  readonly tier = 2 as const;
  // Dice serves both search and detail pages to a plain HTTP client with a
  // normal User-Agent; a proxy is no longer required. `--proxy` is still
  // honored when supplied.
  needsProxy = false;

  private readonly queries: string[];

  constructor(queries?: string[]) {
    super();
    this.queries = queries && queries.length > 0 ? queries : DEFAULT_QUERIES;
  }

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const listings = new Map<string, DiceListing>();

    // Phase 1 — enumerate job IDs from the search pages.
    for (const query of this.queries) {
      const searchUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(query)}&filters.isRemote=true&page=1&pageSize=20`;
      try {
        if (opts.verbose) console.log(`[dice] Searching: ${query}...`);

        const html = await httpGetText(searchUrl, {
          rateLimit: 3000,
          proxy: opts.proxy,
        });

        for (const listing of this.extractListings(html)) {
          if (!listings.has(listing.id)) listings.set(listing.id, listing);
        }
      } catch (err) {
        errors.push(`Dice search failed for "${query}": ${err}`);
      }
    }

    if (listings.size === 0) {
      if (errors.length === 0) {
        errors.push("Dice search returned 0 job links — markup drift?");
      }
      return this.makeResult([], errors);
    }

    // Phase 2 — pull the detail page for each job.
    let queue = [...listings.values()];
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `Dice: capped detail fetches at ${MAX_DETAILS_PER_RUN}, skipped ${dropped} listing(s) this run`
      );
      if (opts.verbose) console.log(`[dice] Capping details at ${MAX_DETAILS_PER_RUN} (${dropped} skipped)`);
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }

    if (opts.verbose) console.log(`[dice] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const jobs = await mapLimit(queue, DETAIL_CONCURRENCY, async (listing) => {
      try {
        const html = await httpGetText(listing.url, {
          rateLimit: 250,
          proxy: opts.proxy,
        });
        const posting = findJsonLdType(html, "JobPosting");
        if (posting) {
          enriched++;
          return this.mapLdJob(posting, listing);
        }
      } catch {
        // Fall through to the listing-only record below.
      }
      // Detail fetch failed or the page had no JobPosting block: keep the job
      // with what the search page gave us rather than dropping it entirely.
      return this.listingOnlyJob(listing);
    });

    const resolved = jobs.filter((j): j is RawJob => j !== null);

    if (enriched < resolved.length) {
      errors.push(
        `Dice: ${resolved.length - enriched} of ${resolved.length} job(s) fell back to listing-only data (no JobPosting on detail page)`
      );
    }
    if (opts.verbose) {
      console.log(`[dice] Total: ${resolved.length} jobs (${enriched} with full detail)`);
    }

    return this.makeResult(resolved, errors);
  }

  /**
   * Pull job IDs and titles off a search page. Dice renders result cards as
   * `<a aria-label="View Details for {title} ({hash})" href="/job-detail/{uuid}">`.
   * The bare `/job-detail/{uuid}` link scan is the fallback when the aria-label
   * pattern changes, since the UUID is all Phase 2 strictly needs.
   */
  private extractListings(html: string): DiceListing[] {
    const found = new Map<string, DiceListing>();

    const labelled =
      /<a[^>]*aria-label="View Details for ([^"]*?)\s*\(([a-f0-9]+)\)"[^>]*href="([^"]*\/job-detail\/([a-f0-9-]{36})[^"]*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = labelled.exec(html)) !== null) {
      const [, rawTitle, , , id] = match;
      const title = decodeEntities(rawTitle);
      if (!id || !title) continue;
      found.set(id, { id, title, url: this.detailUrl(id) });
    }

    // Attribute order varies between Dice's server-rendered and hydrated
    // markup, so also try href-before-aria-label.
    const labelledAlt =
      /<a[^>]*href="[^"]*\/job-detail\/([a-f0-9-]{36})[^"]*"[^>]*aria-label="View Details for ([^"]*?)\s*\([a-f0-9]+\)"/gi;
    while ((match = labelledAlt.exec(html)) !== null) {
      const [, id, rawTitle] = match;
      const title = decodeEntities(rawTitle);
      if (!id || !title || found.has(id)) continue;
      found.set(id, { id, title, url: this.detailUrl(id) });
    }

    if (found.size === 0) {
      const bare = /\/job-detail\/([a-f0-9-]{36})/gi;
      while ((match = bare.exec(html)) !== null) {
        const id = match[1];
        if (found.has(id)) continue;
        // Title is unknown here; the detail page supplies it.
        found.set(id, { id, title: "", url: this.detailUrl(id) });
      }
    }

    return [...found.values()];
  }

  private detailUrl(id: string): string {
    return `https://www.dice.com/job-detail/${id}`;
  }

  /**
   * Map a schema.org JobPosting onto the listing stub. `source_id` is always
   * the bare Dice UUID so that the HTTP pass and the browser pass converge on
   * the same row instead of inserting the job twice.
   */
  private mapLdJob(data: Record<string, any>, listing: DiceListing): RawJob {
    const base = this.listingStub(listing);
    const enriched = applyJobPosting(base, data);

    // Dice repeats the employer under identifier.name; use it when the
    // hiringOrganization block is missing or empty.
    if (enriched.company === "Unknown" && data.identifier?.name) {
      enriched.company = decodeEntities(String(data.identifier.name));
    }
    if (typeof data.url === "string" && data.url) enriched.url = data.url;

    return enriched;
  }

  private listingStub(listing: DiceListing): RawJob {
    return {
      source: "dice",
      source_id: listing.id,
      title: listing.title,
      company: "Unknown",
      url: listing.url,
      source_url: listing.url,
      location: "Remote",
      remote_type: "fully_remote",
      job_type: "full_time",
    };
  }

  private listingOnlyJob(listing: DiceListing): RawJob | null {
    if (!listing.title) return null;
    return this.listingStub(listing);
  }
}
