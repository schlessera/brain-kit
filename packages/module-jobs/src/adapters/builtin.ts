import { BaseAdapter } from "./base.js";
import { httpGetText } from "../http.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// BuiltIn embeds JSON-LD ListItem schema in remote jobs pages
const BASE_URL = "https://builtin.com/jobs/remote";
const PAGES_TO_FETCH = 5; // 10 jobs per page

export class BuiltInAdapter extends BaseAdapter {
  readonly source = "builtin" as const;
  readonly name = "BuiltIn";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const jobs: RawJob[] = [];

    for (let page = 0; page < PAGES_TO_FETCH; page++) {
      try {
        const url = page === 0 ? BASE_URL : `${BASE_URL}?page=${page}`;
        if (opts.verbose) console.log(`[builtin] Fetching page ${page}...`);

        const html = await httpGetText(url, {
          rateLimit: 2000,
          proxy: opts.proxy,
        });

        const pageJobs = this.extractJobs(html);
        if (pageJobs.length === 0) break; // no more pages

        jobs.push(...pageJobs);
      } catch (err) {
        errors.push(`BuiltIn page ${page} failed: ${err}`);
        break;
      }
    }

    if (opts.verbose) console.log(`[builtin] Found ${jobs.length} jobs`);
    return this.makeResult(jobs, errors);
  }

  private extractJobs(html: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Extract JSON-LD data
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;

    while ((match = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);

        // Handle ItemList directly
        if (data["@type"] === "ItemList" && data.itemListElement) {
          for (const item of data.itemListElement) {
            if (!item.name && !item.item?.name) continue;
            const name = item.name || item.item?.name;
            const url = item.url || item.item?.url;
            if (!name) continue;

            const fullUrl = url?.startsWith("http") ? url : url ? `https://builtin.com${url}` : undefined;
            const urlParts = (url || "").split("/");
            const company = this.extractCompany(html, url || "") || urlParts[4] || "Unknown";

            jobs.push({
              source: "builtin",
              source_id: url || `builtin-${item.position}`,
              title: name,
              company: this.cleanCompanyName(company),
              description: item.description || item.item?.description,
              url: fullUrl,
              source_url: fullUrl,
              location: "Remote",
              remote_type: "fully_remote",
              job_type: "full_time",
            });
          }
        }

        // Handle CollectionPage wrapping ItemList
        if (data["@type"] === "CollectionPage" && data.mainEntity?.itemListElement) {
          for (const item of data.mainEntity.itemListElement) {
            const name = item.name || item.item?.name;
            const url = item.url || item.item?.url;
            if (!name) continue;

            const fullUrl = url?.startsWith("http") ? url : url ? `https://builtin.com${url}` : undefined;
            const company = this.extractCompany(html, url || "") || "Unknown";

            jobs.push({
              source: "builtin",
              source_id: url || `builtin-${item.position}`,
              title: name,
              company: this.cleanCompanyName(company),
              description: item.description,
              url: fullUrl,
              source_url: fullUrl,
              location: "Remote",
              remote_type: "fully_remote",
              job_type: "full_time",
            });
          }
        }
      } catch {
        // Skip malformed JSON-LD
      }
    }

    // Fallback: parse job cards from HTML if no JSON-LD
    if (jobs.length === 0) {
      const cardRegex =
        /<a[^>]*href="(\/jobs\/remote\/[^"]*)"[^>]*>[\s\S]*?<h2[^>]*>(.*?)<\/h2>[\s\S]*?<div[^>]*company[^>]*>(.*?)<\/div>/gi;
      let cardMatch: RegExpExecArray | null;
      while ((cardMatch = cardRegex.exec(html)) !== null) {
        const [, href, title, company] = cardMatch;
        jobs.push({
          source: "builtin",
          source_id: href,
          title: this.stripHtml(title),
          company: this.stripHtml(company),
          url: `https://builtin.com${href}`,
          source_url: `https://builtin.com${href}`,
          location: "Remote",
          remote_type: "fully_remote",
          job_type: "full_time",
        });
      }
    }

    return jobs;
  }

  private extractCompany(html: string, jobUrl: string): string | null {
    // Try to find company name near the job URL in the HTML
    const escaped = jobUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}[\\s\\S]{0,500}?company[^>]*>([^<]+)<`, "i");
    const match = pattern.exec(html);
    return match ? match[1].trim() : null;
  }

  private cleanCompanyName(name: string): string {
    return name
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }
}
