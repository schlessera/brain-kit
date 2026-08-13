import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import { mapLimit } from "../concurrency.js";
import { decodeEntities, findJsonLdType, stripHtml } from "../html.js";
import { applyJobPosting } from "../jsonld-job.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// The old category browse URLs (/remote-jobs/{location}/{category}) now return
// HTTP 410 with a noindex landing page — Jobgether consolidated browsing onto
// /search-offers, which is server-rendered and needs no JS.
//
// Card shape:
//   <a href="/offer/{id}-{slug}" ... title="Job Title">Job Title</a>
//   <a href="/remote-jobs/company-{slug}">Company Name</a>
//
// The company's display name is the anchor text; the previous adapter
// title-cased the URL slug instead, which mangled anything with punctuation or
// unusual casing.
//
// Pagination is client-side: `?page=2` serves byte-identical markup to page 1,
// so listing a range of page URLs only burns requests. One listing fetch it is,
// and the per-run yield is whatever that page holds.
const SEARCH_URLS = ["https://jobgether.com/search-offers"];

const DETAIL_CONCURRENCY = 3;
const MAX_DETAILS_PER_RUN = 100;

export class JobgetherAdapter extends BaseAdapter {
  readonly source = "jobgether" as const;
  readonly name = "Jobgether";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();

    for (const searchUrl of SEARCH_URLS) {
      try {
        if (opts.verbose) console.log(`[jobgether] Fetching: ${searchUrl}...`);

        const html = await httpGetText(searchUrl, {
          rateLimit: 3000,
          proxy: opts.proxy,
        });

        const jobs = this.parseListings(html);
        if (jobs.length === 0) {
          errors.push(`Jobgether: 0 offers parsed from ${searchUrl} — markup drift?`);
          continue;
        }

        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[jobgether] Found ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`Jobgether search failed for ${searchUrl}: ${err}`);
      }
    }

    if (allJobs.length === 0) return this.makeResult([], errors);

    // Offer pages carry a full JobPosting block: description, salary, and the
    // employer for the cards whose listing markup omits the company anchor.
    let queue = allJobs;
    if (queue.length > MAX_DETAILS_PER_RUN) {
      const dropped = queue.length - MAX_DETAILS_PER_RUN;
      errors.push(
        `Jobgether: capped detail fetches at ${MAX_DETAILS_PER_RUN}, ${dropped} job(s) kept without description`
      );
      queue = queue.slice(0, MAX_DETAILS_PER_RUN);
    }
    const listingOnly = allJobs.slice(queue.length);

    if (opts.verbose) console.log(`[jobgether] Fetching ${queue.length} detail pages...`);

    let enriched = 0;
    const detailed = await mapLimit(queue, DETAIL_CONCURRENCY, async (job) => {
      try {
        const html = await httpGetText(job.url!, { rateLimit: 250, proxy: opts.proxy });
        const posting = findJsonLdType(html, "JobPosting");
        if (posting) {
          enriched++;
          return applyJobPosting(job, posting);
        }
      } catch {
        // Keep the listing-level record.
      }
      return job;
    });

    const jobs = [...detailed.filter((j): j is RawJob => j !== null), ...listingOnly];

    // Jobgether's listing markup omits the employer on some cards, so a failed
    // detail fetch costs both the description and the company name.
    if (enriched < queue.length) {
      errors.push(
        `Jobgether: ${queue.length - enriched} of ${queue.length} job(s) stored without a description (detail fetch or JobPosting missing)`
      );
    }

    if (opts.verbose) console.log(`[jobgether] Total: ${jobs.length} unique jobs (${enriched} with description)`);
    return this.makeResult(jobs, errors);
  }

  private parseListings(html: string): RawJob[] {
    const jobs: RawJob[] = [];
    const seen = new Set<string>();

    const offerRe = /<a[^>]*href="\/offer\/([a-z0-9]+)-([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = offerRe.exec(html)) !== null) {
      const [fullMatch, id, slug, inner] = match;
      if (!id || seen.has(id)) continue;

      // Prefer the anchor's title attribute; fall back to its text.
      const titleAttr = fullMatch.match(/\btitle="([^"]+)"/i);
      const title = decodeEntities(titleAttr ? titleAttr[1] : stripHtml(inner));
      if (!title || title.length < 3) continue;
      seen.add(id);

      const tail = html.slice(match.index, match.index + 2500);

      const companyMatch = tail.match(
        /<a[^>]*href="\/remote-jobs\/company-[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      );
      const company = companyMatch
        ? decodeEntities(stripHtml(companyMatch[1])) || "Unknown"
        : "Unknown";

      const salaryMatch = tail.match(/[€$£]\s?[\d,.]+\s*(?:-|to|–|—)\s*[€$£]?\s?[\d,.]+/);
      const salaryRaw = salaryMatch ? salaryMatch[0].trim() : undefined;

      let currency: string | undefined;
      if (salaryRaw) {
        if (salaryRaw.includes("€")) currency = "EUR";
        else if (salaryRaw.includes("£")) currency = "GBP";
        else if (salaryRaw.includes("$")) currency = "USD";
      }

      const tagMatches = title.match(
        /\b(?:Senior|Junior|Mid-level|Lead|Staff|Principal|Entry|Executive)\b/gi
      );
      const tags = tagMatches
        ? [...new Set(tagMatches.map((t) => t.toLowerCase()))]
        : undefined;

      const href = `/offer/${id}-${slug}`;
      jobs.push({
        source: "jobgether",
        // source_id keeps the historical `{id}-{slug}` shape so existing rows
        // continue to match rather than being re-inserted as new jobs.
        source_id: `${id}-${slug}`,
        title,
        company,
        url: `https://jobgether.com${href}`,
        source_url: `https://jobgether.com${href}`,
        location: "Remote",
        remote_type: "fully_remote",
        job_type: "full_time",
        tags,
        salary_raw: salaryRaw,
        salary_currency: currency,
      });
    }

    return jobs;
  }
}
