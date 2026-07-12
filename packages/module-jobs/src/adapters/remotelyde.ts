import { BaseAdapter } from "./base";
import { httpGetText } from "../http";
import type { RawJob, ScrapeOptions } from "../types";

// remotely.de uses Next.js RSC with JSON-LD JobPosting schema
// German job board -- has English-language jobs too
const PAGES_TO_FETCH = 5;
const BASE_URL = "https://remotely.de/remote-jobs";

export class RemotelyDeAdapter extends BaseAdapter {
  readonly source = "remotelyde" as const;
  readonly name = "Remotely.de";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();

    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      try {
        const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
        if (opts.verbose) console.log(`[remotelyde] Fetching page ${page}...`);

        const html = await httpGetText(url, {
          rateLimit: 2000,
          proxy: opts.proxy,
        });

        const jobs = this.extractJobs(html);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[remotelyde] Page ${page}: ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`remotely.de page ${page} failed: ${err}`);
      }
    }

    if (opts.verbose) console.log(`[remotelyde] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, errors);
  }

  private extractJobs(html: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Extract JSON-LD JobPosting objects
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;

    while ((match = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);

        // Handle ItemList with JobPosting items
        if (data["@type"] === "ItemList" && data.itemListElement) {
          for (const item of data.itemListElement) {
            const posting = item.item || item;
            if (posting["@type"] === "JobPosting") {
              const job = this.mapJobPosting(posting);
              if (job) jobs.push(job);
            }
          }
        }

        // Handle CollectionPage
        if (data["@type"] === "CollectionPage" && data.mainEntity?.itemListElement) {
          for (const item of data.mainEntity.itemListElement) {
            const posting = item.item || item;
            if (posting["@type"] === "JobPosting") {
              const job = this.mapJobPosting(posting);
              if (job) jobs.push(job);
            }
          }
        }

        // Handle single JobPosting
        if (data["@type"] === "JobPosting") {
          const job = this.mapJobPosting(data);
          if (job) jobs.push(job);
        }

        // Handle array of schemas
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item["@type"] === "JobPosting") {
              const job = this.mapJobPosting(item);
              if (job) jobs.push(job);
            }
          }
        }
      } catch {}
    }

    // Fallback: parse links to job detail pages
    if (jobs.length === 0) {
      const linkRegex = /<a[^>]*href="(\/remote-jobs\/([^"?]+))"[^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch: RegExpExecArray | null;
      const seen = new Set<string>();

      while ((linkMatch = linkRegex.exec(html)) !== null) {
        const [, href, slug, content] = linkMatch;
        if (seen.has(slug) || slug === "page") continue;
        seen.add(slug);

        const title = this.stripHtml(content).trim();
        if (!title || title.length < 5 || title.length > 200) continue;

        jobs.push({
          source: "remotelyde",
          source_id: slug,
          title,
          company: "Unknown",
          url: `https://remotely.de${href}`,
          source_url: `https://remotely.de${href}`,
          location: "Germany (Remote)",
          remote_type: "fully_remote",
          job_type: "full_time",
        });
      }
    }

    return jobs;
  }

  private mapJobPosting(posting: Record<string, any>): RawJob | null {
    const title = posting.title;
    if (!title) return null;

    const company = posting.hiringOrganization?.name || "Unknown";
    const id = posting.identifier?.value || posting.url || `${company}-${title}`;

    // Parse location
    const location = posting.jobLocation?.address?.addressLocality
      || posting.jobLocation?.address?.addressCountry
      || "Germany (Remote)";

    // Parse employment type
    let jobType: RawJob["job_type"] = "full_time";
    const empType = (posting.employmentType || "").toLowerCase();
    if (empType.includes("contract") || empType.includes("freelance")) jobType = "contract";
    else if (empType.includes("part") || empType.includes("teilzeit")) jobType = "part_time";

    // Parse salary
    const salary = posting.baseSalary?.value;
    let salaryMin: number | undefined;
    let salaryMax: number | undefined;
    let salaryCurrency: string | undefined;
    if (salary) {
      salaryMin = salary.minValue;
      salaryMax = salary.maxValue;
      salaryCurrency = salary.currency || posting.baseSalary?.currency || "EUR";
    }

    // Remote type
    const isRemote = posting.jobLocationType === "TELECOMMUTE"
      || posting.applicantLocationRequirements != null;

    return {
      source: "remotelyde",
      source_id: String(id),
      title,
      company,
      description: posting.description ? this.stripHtml(posting.description) : undefined,
      url: posting.url || (posting.identifier?.value ? `https://remotely.de/remote-jobs/${posting.identifier.value}` : undefined),
      source_url: posting.url,
      location,
      remote_type: isRemote ? "fully_remote" : "unknown",
      job_type: jobType,
      salary_min: salaryMin,
      salary_max: salaryMax,
      salary_currency: salaryCurrency,
      published_at: posting.datePosted,
      expires_at: posting.validThrough,
    };
  }
}
