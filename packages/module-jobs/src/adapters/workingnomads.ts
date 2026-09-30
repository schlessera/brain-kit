import { BaseAdapter } from "./base.js";
import type { RawJob } from "../types.js";
import type { AdapterRunOptions } from "@schlessera/brain-scrape";

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

  protected async scrapePages(opts: AdapterRunOptions) {
    const pages = this.ledger();
    const jobs: RawJob[] = [];

    try {
      this.ctx.log("[workingnomads] Fetching API...");

      const data = await this.http.getJson<WorkingNomadsJob[]>(API_URL, this.fetchOptions(opts));

      if (!Array.isArray(data)) {
        pages.note("Working Nomads API returned non-array response");
        pages.read(API_URL, 0);
        return this.makeResult(jobs, pages);
      }

      // The FULL feed is ingested every run (single cheap request) so the
      // upsert refreshes last_seen_at on jobs that are still live. The cursor
      // only tracks the newest publication date for run metadata.
      let newestDate = opts.incremental && opts.cursor ? opts.cursor : "";

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

      // The endpoint answers with a bare array of postings, so an empty one
      // is the API's own way of saying it has none. Records that no longer
      // carry a `title` and a `company_name` leave the array non-empty, so
      // they report drift rather than emptiness.
      pages.read(API_URL, jobs.length, { declaredEmpty: data.length === 0 });

      this.ctx.log(`[workingnomads] Found ${jobs.length} jobs`);
      return this.makeResult(jobs, pages, newestDate || undefined);
    } catch (err) {
      pages.unreachable(API_URL, err);
      return this.makeResult(jobs, pages);
    }
  }
}
