import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

const API_URL = "https://remotive.com/api/remote-jobs";
const CATEGORIES = ["software-dev", "product", "data", "devops-sysadmin", "management-finance"];
const DELAY_MS = 2000;

interface RemotiveJob {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  company_logo?: string;
  company_logo_url?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  "job-count"?: number;
  jobs?: RemotiveJob[];
}

export class RemotiveAdapter extends BaseAdapter {
  readonly source = "remotive" as const;
  readonly name = "Remotive";
  readonly tier = 1 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const pages = this.ledger();
    const allJobs: RawJob[] = [];
    // The FULL feed is ingested every run (categories are cheap requests) so
    // the upsert refreshes last_seen_at on jobs that are still live. The
    // cursor only tracks the newest publication date for run metadata.
    let newestDate = opts.incremental && opts.lastCursor ? opts.lastCursor : "";

    for (const category of CATEGORIES) {
      const url = `${API_URL}?category=${category}&limit=100`;
      try {
        if (opts.verbose) console.log(`[remotive] Fetching category: ${category}...`);

        const data = await this.http.getJson<RemotiveResponse>(url, {
          delayMs: DELAY_MS,
          proxy: opts.proxy,
        });

        // An envelope with a `jobs` array and nothing in it is this API saying
        // the category is empty. An envelope whose records no longer carry a
        // `title` and a `company_name` is the shape moving, and the loop below
        // skips every one of them — so the two cases are separated here,
        // before the count can conflate them.
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const before = allJobs.length;

        for (const entry of jobs) {
          if (!entry.title || !entry.company_name) continue;

          const pubDate = entry.publication_date;
          if (pubDate && pubDate > newestDate) newestDate = pubDate;

          // Parse job_type
          let jobType: RawJob["job_type"] = "unknown";
          if (entry.job_type) {
            const jt = entry.job_type.toLowerCase();
            if (jt.includes("full")) jobType = "full_time";
            else if (jt.includes("contract") || jt.includes("freelance")) jobType = "contract";
            else if (jt.includes("part")) jobType = "part_time";
          }

          allJobs.push({
            source: "remotive",
            source_id: String(entry.id || ""),
            title: entry.title,
            company: entry.company_name,
            description: entry.description,
            url: entry.url,
            source_url: entry.url,
            location: entry.candidate_required_location || "Remote",
            remote_type: "fully_remote",
            job_type: jobType,
            category: entry.category || category,
            tags: entry.tags,
            salary_raw: entry.salary && entry.salary !== "Not specified" ? entry.salary : undefined,
            published_at: pubDate,
          });
        }

        pages.read(url, allJobs.length - before, {
          declaredEmpty: Array.isArray(data.jobs) && jobs.length === 0,
        });

        if (opts.verbose) console.log(`[remotive] ${category}: ${jobs.length} jobs`);
      } catch (err) {
        pages.unreachable(url, err);
      }
    }

    if (opts.verbose) console.log(`[remotive] Total: ${allJobs.length} jobs`);
    return this.makeResult(allJobs, pages, newestDate || undefined);
  }
}
