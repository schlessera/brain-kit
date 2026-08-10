import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// SimplyHired uses Chakra UI with consistent class patterns
const BASE_URL = "https://www.simplyhired.com/search";
const RESULTS_PER_PAGE = 20;

// Neutral default search terms — override via the module `queries` config to
// target the roles you actually care about.
const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

export class SimplyHiredAdapter extends BaseAdapter {
  readonly source = "simplyhired" as const;
  readonly name = "SimplyHired";
  readonly tier = 2 as const;

  private readonly queries: string[];

  constructor(queries?: string[]) {
    super();
    this.queries = queries && queries.length > 0 ? queries : DEFAULT_QUERIES;
  }

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();

    for (const query of this.queries) {
      try {
        if (opts.verbose) console.log(`[simplyhired] Searching: ${query}...`);

        const url = `${BASE_URL}?q=${encodeURIComponent(query)}&l=remote&pn=1`;
        const html = await httpGetText(url, {
          rateLimit: 3000,
          proxy: opts.proxy,
        });

        const jobs = this.parseListings(html);
        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[simplyhired] ${query}: ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`SimplyHired query "${query}" failed: ${err}`);
      }
    }

    if (opts.verbose) console.log(`[simplyhired] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, errors);
  }

  private parseListings(html: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Scan for job links and surrounding content
    const linkRegex = /<a[^>]*href="(\/job\/([^"?]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    // Collect all job links with their titles
    const jobLinks: Array<{ id: string; href: string; title: string; context: string }> = [];

    while ((match = linkRegex.exec(html)) !== null) {
      const [fullMatch, href, id, titleHtml] = match;
      const title = this.stripHtml(titleHtml).trim();

      // Skip navigation/filter links, only want actual job titles
      if (!id || seen.has(id) || title.length < 5 || href.includes("clk")) continue;
      seen.add(id);

      // Grab surrounding context (1500 chars after the link) for metadata extraction
      const startIdx = match.index;
      const context = html.slice(startIdx, startIdx + 1500);

      jobLinks.push({ id, href, title, context });
    }

    for (const { id, href, title, context } of jobLinks) {
      // Extract company name (typically follows the title link)
      const companyMatch =
        context.match(/class="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\//) ||
        context.match(/<span[^>]*data-testid="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\//) ||
        context.match(/class="[^"]*employer[^"]*"[^>]*>([\s\S]*?)<\//);
      const company = companyMatch ? this.stripHtml(companyMatch[1]) : "Unknown";

      // Extract location
      const locationMatch =
        context.match(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//) ||
        context.match(/Remote[^<]*/i);
      const location = locationMatch ? this.stripHtml(locationMatch[0]) : "Remote";

      // Extract salary
      const salaryMatch = context.match(
        /\$[\d,]+(?:\.\d{2})?\s*(?:-|to|–)\s*\$[\d,]+(?:\.\d{2})?\s*(?:a year|per year|annually|\/yr)?/i
      );
      let salaryRaw = salaryMatch ? salaryMatch[0] : undefined;
      let salaryMin: number | undefined;
      let salaryMax: number | undefined;

      if (salaryRaw) {
        const nums = salaryRaw.match(/[\d,]+/g);
        if (nums && nums.length >= 2) {
          salaryMin = parseInt(nums[0].replace(/,/g, ""));
          salaryMax = parseInt(nums[1].replace(/,/g, ""));
        }
      }

      // Extract job type
      const typeMatch = context.match(/(?:Full-time|Part-time|Contract|Temporary|Internship)/i);
      let jobType: RawJob["job_type"] = "full_time";
      if (typeMatch) {
        const t = typeMatch[0].toLowerCase();
        if (t.includes("contract") || t.includes("temporary")) jobType = "contract";
        else if (t.includes("part")) jobType = "part_time";
      }

      jobs.push({
        source: "simplyhired",
        source_id: id,
        title,
        company,
        url: `https://www.simplyhired.com${href}`,
        source_url: `https://www.simplyhired.com${href}`,
        location,
        remote_type: "fully_remote",
        job_type: jobType,
        salary_min: salaryMin,
        salary_max: salaryMax,
        salary_raw: salaryRaw,
        salary_currency: salaryRaw ? "USD" : undefined,
      });
    }

    return jobs;
  }
}
