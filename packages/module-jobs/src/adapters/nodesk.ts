import { BaseAdapter } from "./base";
import { httpGetText } from "../http";
import type { RawJob, ScrapeOptions } from "../types";

const BASE_URL = "https://nodesk.co/remote-jobs/";

export class NodeskAdapter extends BaseAdapter {
  readonly source = "nodesk" as const;
  readonly name = "Nodesk";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const jobs: RawJob[] = [];

    try {
      if (opts.verbose) console.log("[nodesk] Fetching remote jobs page...");

      const html = await httpGetText(BASE_URL, {
        rateLimit: 2000,
        proxy: opts.proxy,
      });

      // Parse job listings from HTML
      // Nodesk uses .job-listing divs with structured content
      const listingRegex =
        /<article[^>]*class="[^"]*job[^"]*"[^>]*>[\s\S]*?<\/article>/gi;
      const listings = html.match(listingRegex) || [];

      // Fallback: try different container patterns
      const cards = listings.length > 0 ? listings : this.extractCards(html);

      for (const card of cards) {
        const job = this.parseCard(card);
        if (job) jobs.push(job);
      }

      // If regex approach didn't work, try line-by-line link extraction
      if (jobs.length === 0) {
        const linkJobs = this.extractFromLinks(html);
        jobs.push(...linkJobs);
      }

      if (opts.verbose) console.log(`[nodesk] Found ${jobs.length} jobs`);
    } catch (err) {
      errors.push(`Nodesk fetch failed: ${err}`);
    }

    return this.makeResult(jobs, errors);
  }

  private extractCards(html: string): string[] {
    // Try various card patterns
    const patterns = [
      /<div[^>]*class="[^"]*job-listing[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi,
      /<li[^>]*class="[^"]*job[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
      /<div[^>]*class="[^"]*listing[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*listing)/gi,
    ];

    for (const pattern of patterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) return matches;
    }
    return [];
  }

  private parseCard(cardHtml: string): RawJob | null {
    // Extract title and URL
    const titleMatch = cardHtml.match(/<a[^>]*href="(\/remote-jobs\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) return null;

    const [, href, titleHtml] = titleMatch;
    const title = this.stripHtml(titleHtml);
    if (!title) return null;

    // Extract company
    const companyMatch =
      cardHtml.match(/<a[^>]*href="\/remote-companies\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      cardHtml.match(/class="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\//i);
    const company = companyMatch ? this.stripHtml(companyMatch[1]) : "Unknown";

    // Extract location/region
    const locationMatch = cardHtml.match(/(?:Europe|US|Asia|Canada|Anywhere|Remote|Global|Worldwide)/i);
    const location = locationMatch ? locationMatch[0] : "Remote";

    // Extract tags
    const tagMatches = cardHtml.match(/<span[^>]*class="[^"]*tag[^"]*"[^>]*>([\s\S]*?)<\/span>/gi);
    const tags = tagMatches
      ? tagMatches.map((t) => this.stripHtml(t).toLowerCase()).filter(Boolean)
      : undefined;

    // Extract job type
    const typeMatch = cardHtml.match(/(?:Full-Time|Part-Time|Contract|Freelance|Internship)/i);
    let jobType: RawJob["job_type"] = "full_time";
    if (typeMatch) {
      const t = typeMatch[0].toLowerCase();
      if (t.includes("contract") || t.includes("freelance")) jobType = "contract";
      else if (t.includes("part")) jobType = "part_time";
    }

    // Extract salary if present
    const salaryMatch = cardHtml.match(/\$[\d,]+\s*-\s*\$[\d,]+/);
    const salaryRaw = salaryMatch ? salaryMatch[0] : undefined;

    return {
      source: "nodesk",
      source_id: href,
      title,
      company,
      url: `https://nodesk.co${href}`,
      source_url: `https://nodesk.co${href}`,
      location,
      remote_type: "fully_remote",
      job_type: jobType,
      tags,
      salary_raw: salaryRaw,
      salary_currency: salaryRaw ? "USD" : undefined,
    };
  }

  private extractFromLinks(html: string): RawJob[] {
    const jobs: RawJob[] = [];
    // Match links to individual job pages
    const linkRegex = /<a[^>]*href="(\/remote-jobs\/[a-z0-9-]+\/)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const [, href, titleHtml] = match;
      if (seen.has(href)) continue;
      seen.add(href);

      const title = this.stripHtml(titleHtml);
      if (!title || title.length < 5) continue;

      jobs.push({
        source: "nodesk",
        source_id: href,
        title,
        company: "Unknown",
        url: `https://nodesk.co${href}`,
        source_url: `https://nodesk.co${href}`,
        location: "Remote",
        remote_type: "fully_remote",
        job_type: "full_time",
      });
    }
    return jobs;
  }
}
