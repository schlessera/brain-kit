import { BaseAdapter } from "./base";
import { httpGetText } from "../http";
import { ANNUALIZED_MARKER, parseSalaryRange } from "../salary";
import type { RawJob, ScrapeOptions } from "../types";

// Dice embeds job data as JSON in server-rendered HTML.
// Neutral default search terms — override via the module `queries` config.
const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

interface DiceJob {
  guid?: string;
  title?: string;
  companyName?: string;
  summary?: string;
  detailsPageUrl?: string;
  jobLocation?: { displayName?: string };
  postedDate?: string;
  employmentType?: string;
  salary?: string;
  isRemote?: boolean;
  workplaceTypes?: string[];
  easyApply?: boolean;
}

export class DiceAdapter extends BaseAdapter {
  readonly source = "dice" as const;
  readonly name = "Dice";
  readonly tier = 2 as const;
  needsProxy = true;

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
      const searchUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(query)}&filters.isRemote=true&page=1&pageSize=20`;
      try {
        if (opts.verbose) console.log(`[dice] Fetching: ${query}...`);

        const html = await httpGetText(searchUrl, {
          rateLimit: 3000,
          proxy: opts.proxy,
        });

        const jobs = this.extractJobs(html);
        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[dice] Found ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`Dice search failed: ${err}`);
      }
    }

    if (opts.verbose) console.log(`[dice] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, errors);
  }

  private extractJobs(html: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Try to find embedded JSON data (Dice puts job data in script tags or data attributes)
    // Pattern 1: JSON array in script tag
    const jsonRegex = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/;
    const jsonMatch = jsonRegex.exec(html);
    if (jsonMatch) {
      try {
        const state = JSON.parse(jsonMatch[1]);
        const jobList = state?.search?.jobs || state?.jobs || [];
        for (const entry of jobList) {
          const job = this.mapDiceJob(entry);
          if (job) jobs.push(job);
        }
        return jobs;
      } catch {}
    }

    // Pattern 2: Individual job card data attributes or JSON-LD
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let ldMatch: RegExpExecArray | null;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        if (data["@type"] === "JobPosting") {
          jobs.push(this.mapLdJob(data));
        } else if (Array.isArray(data)) {
          for (const item of data) {
            if (item["@type"] === "JobPosting") {
              jobs.push(this.mapLdJob(item));
            }
          }
        }
      } catch {}
    }

    // Pattern 3: Parse HTML cards
    if (jobs.length === 0) {
      const cardJobs = this.parseHtmlCards(html);
      jobs.push(...cardJobs);
    }

    return jobs;
  }

  private mapDiceJob(entry: DiceJob): RawJob | null {
    if (!entry.title) return null;

    let jobType: RawJob["job_type"] = "full_time";
    if (entry.employmentType?.toLowerCase().includes("contract")) jobType = "contract";
    else if (entry.employmentType?.toLowerCase().includes("part")) jobType = "part_time";

    // Parse salary (decimals handled; hourly rates annualized)
    let salaryMin: number | undefined;
    let salaryMax: number | undefined;
    let salaryRaw = entry.salary;
    if (entry.salary) {
      const parsed = parseSalaryRange(entry.salary);
      if (parsed.min !== undefined && parsed.max !== undefined) {
        salaryMin = parsed.min;
        salaryMax = parsed.max;
        if (parsed.annualizedFromHourly) salaryRaw = `${entry.salary} ${ANNUALIZED_MARKER}`;
      }
    }

    return {
      source: "dice",
      source_id: entry.guid || entry.detailsPageUrl || "",
      title: entry.title,
      company: entry.companyName || "Unknown",
      description: entry.summary,
      url: entry.detailsPageUrl
        ? entry.detailsPageUrl.startsWith("http")
          ? entry.detailsPageUrl
          : `https://www.dice.com${entry.detailsPageUrl}`
        : undefined,
      source_url: entry.detailsPageUrl
        ? `https://www.dice.com${entry.detailsPageUrl}`
        : undefined,
      location: entry.jobLocation?.displayName || (entry.isRemote ? "Remote" : undefined),
      remote_type: entry.isRemote ? "fully_remote" : "unknown",
      job_type: jobType,
      salary_min: salaryMin,
      salary_max: salaryMax,
      salary_raw: salaryRaw,
      salary_currency: entry.salary ? "USD" : undefined,
      published_at: entry.postedDate,
    };
  }

  private mapLdJob(data: Record<string, any>): RawJob {
    const salary = data.baseSalary?.value;
    return {
      source: "dice",
      source_id: data.identifier?.value || data.url || "",
      title: data.title || "",
      company: data.hiringOrganization?.name || "Unknown",
      description: data.description,
      url: data.url,
      source_url: data.url,
      location: data.jobLocation?.address?.addressLocality || "Remote",
      remote_type: data.jobLocationType === "TELECOMMUTE" ? "fully_remote" : "unknown",
      job_type: data.employmentType?.toLowerCase().includes("full") ? "full_time" : "contract",
      salary_min: salary?.minValue,
      salary_max: salary?.maxValue,
      salary_currency: salary?.currency || "USD",
      published_at: data.datePosted,
    };
  }

  private parseHtmlCards(html: string): RawJob[] {
    const jobs: RawJob[] = [];
    // Match Dice job card links
    const linkRegex = /<a[^>]*href="(\/job-detail\/([^"?]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const [, href, id, titleHtml] = match;
      const title = this.stripHtml(titleHtml).trim();
      if (!id || seen.has(id) || !title || title.length < 5) continue;
      seen.add(id);

      const startIdx = match.index;
      const context = html.slice(startIdx, startIdx + 1500);

      const companyMatch = context.match(/class="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\//i);
      const company = companyMatch ? this.stripHtml(companyMatch[1]) : "Unknown";

      jobs.push({
        source: "dice",
        source_id: id,
        title,
        company,
        url: `https://www.dice.com${href}`,
        source_url: `https://www.dice.com${href}`,
        location: "Remote",
        remote_type: "fully_remote",
        job_type: "full_time",
      });
    }

    return jobs;
  }
}
