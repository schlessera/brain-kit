import { BaseAdapter } from "./base.js";
import type { RawJob } from "../types.js";
import type { AdapterRunOptions } from "@schlessera/brain-scrape";

const RSS_URL = "https://weworkremotely.com/remote-jobs.rss";

export class WeWorkRemotelyAdapter extends BaseAdapter {
  readonly source = "weworkremotely" as const;
  readonly name = "We Work Remotely";
  readonly tier = 1 as const;

  protected async scrapePages(opts: AdapterRunOptions) {
    const pages = this.ledger();
    const jobs: RawJob[] = [];

    try {
      this.ctx.log("[weworkremotely] Fetching RSS feed...");

      const page = await this.http.getPage(RSS_URL, this.fetchOptions(opts, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      }));

      const items = this.parseRssItems(page.body);
      // The FULL feed is ingested every run (single cheap request) so the
      // upsert refreshes last_seen_at on jobs that are still live. The cursor
      // only tracks the newest publication date for run metadata.
      let newestDate = opts.incremental && opts.cursor ? opts.cursor : "";

      for (const item of items) {
        const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : undefined;
        if (pubDate && pubDate > newestDate) newestDate = pubDate;

        const expiresAt = item.expires_at ? new Date(item.expires_at).toISOString() : undefined;

        // Extract company from title pattern "Company: Job Title"
        let title = item.title || "";
        let company = "";
        const colonIdx = title.indexOf(": ");
        if (colonIdx > 0) {
          company = title.substring(0, colonIdx).trim();
          title = title.substring(colonIdx + 2).trim();
        }

        // Determine job type
        let jobType: RawJob["job_type"] = "full_time";
        if (item.type) {
          const t = item.type.toLowerCase();
          if (t.includes("contract")) jobType = "contract";
          else if (t.includes("part")) jobType = "part_time";
        }

        // Parse location from region/country
        const locationParts: string[] = [];
        if (item.region) locationParts.push(item.region);
        if (item.country && item.country !== item.region) locationParts.push(item.country);
        if (item.state) locationParts.push(item.state);
        const location = locationParts.length > 0 ? locationParts.join(", ") : "Remote";

        // Parse skills as tags
        const tags = item.skills
          ? item.skills
              .split(",")
              .map((s: string) => s.trim().toLowerCase())
              .filter(Boolean)
          : undefined;

        // Generate source_id from guid or link
        const sourceId = item.guid || item.link || `${company}-${title}`;

        jobs.push({
          source: "weworkremotely",
          source_id: sourceId,
          title,
          company,
          description: item.description,
          url: item.link,
          source_url: item.guid || item.link,
          location,
          remote_type: "fully_remote",
          job_type: jobType,
          category: item.category,
          tags,
          published_at: pubDate,
          expires_at: expiresAt,
        });
      }

      // A feed document with a channel and no item markup at all is the board
      // saying it has no postings. Two other things parse to no items and must
      // not be mistaken for it: an HTML error page served with a 200, which
      // carries no channel; and a populated feed whose item tags have grown an
      // attribute, which `parseRssItems` matches by bare tag and therefore
      // skips entirely. The second is not hypothetical — it is the defect #33
      // found in remotely.de's JSON-LD, one document type over.
      const channel = /<channel[\s>]/i.test(page.body);
      const anyItemMarkup = /<item[\s>]/i.test(page.body);
      pages.read(RSS_URL, jobs.length, {
        declaredEmpty: channel && !anyItemMarkup,
        from: page.url,
      });

      this.ctx.log(`[weworkremotely] Found ${jobs.length} jobs`);
      return this.makeResult(jobs, pages, newestDate || undefined);
    } catch (err) {
      pages.unreachable(RSS_URL, err);
      return this.makeResult(jobs, pages);
    }
  }
}
