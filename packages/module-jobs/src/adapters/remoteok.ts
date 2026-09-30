import { BaseAdapter } from "./base.js";
import type { RawJob } from "../types.js";
import type { AdapterRunOptions } from "@schlessera/brain-scrape";

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

/** The feed's first element: its terms, not a posting. */
function isLegalNotice(entry: unknown): boolean {
  return !!entry && typeof entry === "object" && "legal" in entry;
}

export class RemoteOKAdapter extends BaseAdapter {
  readonly source = "remoteok" as const;
  readonly name = "RemoteOK";
  readonly tier = 1 as const;

  protected async scrapePages(opts: AdapterRunOptions) {
    const pages = this.ledger();
    const jobs: RawJob[] = [];

    try {
      this.ctx.log("[remoteok] Fetching API...");

      const data = await this.http.getJson<RemoteOKJob[]>(API_URL, this.fetchOptions(opts, {
        headers: { Accept: "application/json" },
        delayMs: 1000,
      }));

      // The feed is a legal notice followed by one object per posting. The
      // notice is dropped by NAME rather than by position, because the two
      // things that must not read the same are "the notice and nothing else"
      // (a feed with no jobs) and "objects whose fields have been renamed"
      // (a feed whose shape moved) — and `filter(position && company)` maps
      // both to an empty array.
      //
      // Only the RECOGNISED metadata is dropped. Anything else stays an entry
      // even when it is unusable, so a feed of nulls counts as a feed with
      // records in it and cannot be reported as one with no jobs in it.
      const entries = Array.isArray(data) ? data.filter((d) => !isLegalNotice(d)) : [];
      const jobEntries = entries.filter((d) => d?.position && d?.company);

      // The FULL feed is ingested every run (single cheap request) so the
      // upsert refreshes last_seen_at on jobs that are still live. The cursor
      // only tracks the newest publication date for run metadata.
      let newestDate = opts.incremental && opts.cursor ? opts.cursor : "";

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

      // `Array.isArray` is the envelope check, and it is load-bearing: the
      // endpoint answering `{"error":"maintenance"}` is valid JSON that
      // produces no entries, and without this it would report as a feed with
      // no jobs in it.
      pages.read(API_URL, jobs.length, {
        declaredEmpty: Array.isArray(data) && entries.length === 0,
      });

      this.ctx.log(`[remoteok] Found ${jobs.length} jobs`);

      return this.makeResult(jobs, pages, newestDate || undefined);
    } catch (err) {
      pages.unreachable(API_URL, err);
      return this.makeResult(jobs, pages);
    }
  }
}
