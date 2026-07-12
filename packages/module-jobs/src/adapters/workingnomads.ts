import { BaseAdapter } from "./base";
import { httpGetJson } from "../http";
import type { RawJob, ScrapeOptions } from "../types";

const API_URL = "https://www.workingnomads.com/api/exposed_jobs/";

interface WorkingNomadsJob {
  url?: string;
  title?: string;
  description?: string;
  company_name?: string;
  category_name?: string;
  tags?: string;
  location?: string;
  pub_date?: string;
}

export class WorkingNomadsAdapter extends BaseAdapter {
  readonly source = "workingnomads" as const;
  readonly name = "Working Nomads";
  readonly tier = 1 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const jobs: RawJob[] = [];

    try {
      if (opts.verbose) console.log("[workingnomads] Fetching API...");

      const data = await httpGetJson<WorkingNomadsJob[]>(API_URL, {
        proxy: opts.proxy,
      });

      if (!Array.isArray(data)) {
        errors.push("Working Nomads API returned non-array response");
        return this.makeResult(jobs, errors);
      }

      // The FULL feed is ingested every run (single cheap request) so the
      // upsert refreshes last_seen_at on jobs that are still live. The cursor
      // only tracks the newest publication date for run metadata.
      let newestDate = opts.incremental && opts.lastCursor ? opts.lastCursor : "";

      for (const entry of data) {
        if (!entry.title || !entry.company_name) continue;

        const pubDate = entry.pub_date ? new Date(entry.pub_date).toISOString() : undefined;
        if (pubDate && pubDate > newestDate) newestDate = pubDate;

        // Extract slug from URL for source_id
        const sourceId = entry.url
          ? entry.url.replace(/.*\/job\/go\//, "").replace(/\/$/, "")
          : `${entry.company_name}-${entry.title}`;

        // Parse comma-separated tags
        const tags = entry.tags
          ? entry.tags
              .split(",")
              .map((t: string) => t.trim().toLowerCase())
              .filter(Boolean)
          : undefined;

        jobs.push({
          source: "workingnomads",
          source_id: sourceId,
          title: entry.title,
          company: entry.company_name,
          description: entry.description,
          url: entry.url,
          source_url: entry.url,
          location: entry.location || "Remote",
          remote_type: "fully_remote",
          job_type: "full_time",
          category: entry.category_name,
          tags,
          published_at: pubDate,
        });
      }

      if (opts.verbose) console.log(`[workingnomads] Found ${jobs.length} jobs`);
      return this.makeResult(jobs, errors, newestDate || undefined);
    } catch (err) {
      errors.push(`Working Nomads fetch failed: ${err}`);
      return this.makeResult(jobs, errors);
    }
  }
}
