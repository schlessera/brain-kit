import { BaseAdapter } from "./base";
import { httpGetJson } from "../http";
import type { RawJob, ScrapeOptions } from "../types";

const API_URL = "https://remoteok.com/api";

interface RemoteOKJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  location?: string;
  tags?: string[];
  description?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
  logo?: string;
  company_logo?: string;
  original?: boolean;
}

export class RemoteOKAdapter extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "RemoteOK";
  readonly tier = 1 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const jobs: RawJob[] = [];

    try {
      if (opts.verbose) console.log("[remoteok] Fetching API...");

      const data = await httpGetJson<RemoteOKJob[]>(API_URL, {
        headers: { Accept: "application/json" },
        rateLimit: 1000,
        proxy: opts.proxy,
      });

      // First element is legal notice / metadata, skip it
      const jobEntries = Array.isArray(data) ? data.filter((d) => d.position && d.company) : [];

      // The FULL feed is ingested every run (single cheap request) so the
      // upsert refreshes last_seen_at on jobs that are still live. The cursor
      // only tracks the newest publication date for run metadata.
      let newestDate = opts.incremental && opts.lastCursor ? opts.lastCursor : "";

      for (const entry of jobEntries) {
        const pubDate = entry.date || (entry.epoch ? new Date(entry.epoch * 1000).toISOString() : undefined);

        if (pubDate && pubDate > newestDate) newestDate = pubDate;

        jobs.push({
          source: "remoteok",
          source_id: String(entry.id || entry.slug || ""),
          title: entry.position || "",
          company: entry.company || "",
          description: entry.description,
          url: entry.apply_url || entry.url,
          source_url: entry.url || (entry.slug ? `https://remoteok.com/remote-jobs/${entry.slug}` : undefined),
          location: entry.location || "Remote",
          remote_type: "fully_remote",
          job_type: "full_time",
          tags: entry.tags,
          salary_min: entry.salary_min && entry.salary_min > 0 ? entry.salary_min : undefined,
          salary_max: entry.salary_max && entry.salary_max > 0 ? entry.salary_max : undefined,
          salary_currency: entry.salary_min && entry.salary_min > 0 ? "USD" : undefined,
          salary_raw:
            entry.salary_min && entry.salary_min > 0
              ? `$${entry.salary_min.toLocaleString()} - $${(entry.salary_max || 0).toLocaleString()}`
              : undefined,
          published_at: pubDate,
        });
      }

      if (opts.verbose) console.log(`[remoteok] Found ${jobs.length} jobs`);

      return this.makeResult(jobs, errors, newestDate || undefined);
    } catch (err) {
      errors.push(`RemoteOK fetch failed: ${err}`);
      return this.makeResult(jobs, errors);
    }
  }
}
