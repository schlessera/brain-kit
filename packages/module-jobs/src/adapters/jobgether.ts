import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// Jobgether has card-based layout with structured job data
// Use category browse URLs (server-rendered) instead of search (may require JS)
const SEARCH_URLS = [
  "https://jobgether.com/remote-jobs/all-locations/software-engineering",
  "https://jobgether.com/remote-jobs/all-locations/data-science",
  "https://jobgether.com/remote-jobs/all-locations/devops-cloud",
  "https://jobgether.com/remote-jobs/germany/software-engineering",
  "https://jobgether.com/remote-jobs/germany/data-science",
];

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
        if (opts.verbose) console.log(`[jobgether] Fetching: ${searchUrl.split("?")[1]}...`);

        const html = await this.http.getText(searchUrl, {
          delayMs: 3000,
          proxy: opts.proxy,
        });

        const jobs = this.parseListings(html);
        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[jobgether] Found ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`Jobgether search failed: ${err}`);
      }
    }

    if (opts.verbose) console.log(`[jobgether] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, errors);
  }

  private parseListings(html: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Match job offer links: /offer/{id}-{slug}
    const offerRegex = /<a[^>]*href="(\/offer\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    // First pass: collect all offer links with context
    const offers: Array<{ id: string; href: string; context: string }> = [];

    while ((match = offerRegex.exec(html)) !== null) {
      const [, href, id] = match;
      if (seen.has(id)) continue;
      seen.add(id);

      // Grab surrounding context for metadata
      const startIdx = Math.max(0, match.index - 200);
      const context = html.slice(startIdx, match.index + 2000);
      offers.push({ id, href, context });
    }

    for (const { id, href, context } of offers) {
      // Extract title from the link or nearby heading
      const titleMatch =
        context.match(new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]+)<`)) ||
        context.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
      const title = titleMatch ? this.stripHtml(titleMatch[1]).trim() : "";
      if (!title || title.length < 5) continue;

      // Extract company
      const companyMatch =
        context.match(/company-([a-z0-9-]+)/i) ||
        context.match(/<(?:span|div|p)[^>]*class="[^"]*company[^"]*"[^>]*>([^<]+)</i);
      let company = "Unknown";
      if (companyMatch) {
        company = companyMatch[1]
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim();
      }

      // Extract location (pattern: "Remote from ...")
      const locationMatch = context.match(/Remote\s+from\s+([^<,]+)/i) || context.match(/(?:Remote|Worldwide|Global)/i);
      const location = locationMatch ? locationMatch[0].trim() : "Remote";

      // Extract salary
      const salaryMatch = context.match(/[€$£][\d,.]+\s*(?:-|to|–)\s*[€$£]?[\d,.]+/);
      const salaryRaw = salaryMatch ? salaryMatch[0] : undefined;

      // Determine currency
      let currency: string | undefined;
      if (salaryRaw) {
        if (salaryRaw.includes("€")) currency = "EUR";
        else if (salaryRaw.includes("$")) currency = "USD";
        else if (salaryRaw.includes("£")) currency = "GBP";
      }

      // Extract experience level / tags
      const tagMatches = context.match(
        /(?:Senior|Junior|Mid-level|Lead|Staff|Principal|Entry|Executive)/gi
      );
      const tags = tagMatches
        ? [...new Set(tagMatches.map((t) => t.toLowerCase()))]
        : undefined;

      jobs.push({
        source: "jobgether",
        source_id: id,
        title,
        company,
        url: `https://jobgether.com${href}`,
        source_url: `https://jobgether.com${href}`,
        location,
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
