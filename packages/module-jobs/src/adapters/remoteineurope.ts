import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

// Webflow-based site with category pages
const CATEGORY_URLS = [
  "https://remoteineurope.com/categories/programming",
  "https://remoteineurope.com/categories/devops-sysadmin",
  "https://remoteineurope.com/categories/product",
  "https://remoteineurope.com/categories/design",
];

export class RemoteInEuropeAdapter extends BaseAdapter {
  readonly source = "remoteineurope" as const;
  readonly name = "Remote in Europe";
  readonly tier = 2 as const;

  async scrape(opts: ScrapeOptions & { lastCursor?: string }) {
    const errors: string[] = [];
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();

    // Also fetch the main page
    const urls = ["https://remoteineurope.com/", ...CATEGORY_URLS];

    for (const pageUrl of urls) {
      try {
        const category = pageUrl.split("/").pop() || "all";
        if (opts.verbose) console.log(`[remoteineurope] Fetching: ${category}...`);

        const html = await this.http.getText(pageUrl, {
          delayMs: 2000,
          proxy: opts.proxy,
        });

        const jobs = this.parseListings(html, category);
        for (const job of jobs) {
          if (!seenIds.has(job.source_id)) {
            seenIds.add(job.source_id);
            allJobs.push(job);
          }
        }

        if (opts.verbose) console.log(`[remoteineurope] ${category}: ${jobs.length} jobs`);
      } catch (err) {
        errors.push(`RemoteInEurope ${pageUrl} failed: ${err}`);
      }
    }

    if (opts.verbose) console.log(`[remoteineurope] Total: ${allJobs.length} unique jobs`);
    return this.makeResult(allJobs, errors);
  }

  private parseListings(html: string, category: string): RawJob[] {
    const jobs: RawJob[] = [];

    // Webflow job links pattern: /job/{slug}
    const linkRegex = /<a[^>]*href="(\/job\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const [, href, slug, content] = match;
      if (seen.has(slug)) continue;
      seen.add(slug);

      // Extract title from link content
      const title = this.stripHtml(content).trim();
      if (!title || title.length < 3 || title.length > 200) continue;

      // Get context around the link for metadata
      const startIdx = Math.max(0, match.index - 500);
      const context = html.slice(startIdx, match.index + 2000);

      // Extract company (typically near the job link in Webflow)
      const companyMatch =
        context.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</i) ||
        context.match(/<(?:h[3-6]|p|div|span)[^>]*>([A-Z][^<]{2,50})<\/(?:h[3-6]|p|div|span)>\s*(?:<[^>]*>)*\s*<a[^>]*href="\/job\//i);
      const company = companyMatch ? this.stripHtml(companyMatch[1]).trim() : "Unknown";

      // Extract location
      const locationMatch = context.match(
        /(?:Europe|EU|Germany|UK|France|Spain|Netherlands|Remote|Worldwide|EMEA)/i
      );
      const location = locationMatch ? `Europe (${locationMatch[0]})` : "Europe (Remote)";

      // Extract posting date
      const dateMatch = context.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{4})?)/i);
      let publishedAt: string | undefined;
      if (dateMatch) {
        try {
          const raw = dateMatch[1];
          const hasYear = /\d{4}/.test(raw);
          const currentYear = new Date().getFullYear();
          let d = new Date(hasYear ? raw : `${raw} ${currentYear}`);
          // Year-less dates mean the most recent past occurrence: if parsing
          // with the current year lands more than a few days in the future,
          // the posting is from last year.
          const graceMs = 7 * 24 * 60 * 60 * 1000;
          if (!hasYear && !isNaN(d.getTime()) && d.getTime() - Date.now() > graceMs) {
            d = new Date(`${raw} ${currentYear - 1}`);
          }
          if (!isNaN(d.getTime())) publishedAt = d.toISOString();
        } catch {}
      }

      // Category from URL
      const cat = category !== "all" ? category : undefined;

      jobs.push({
        source: "remoteineurope",
        source_id: slug,
        title,
        company,
        url: `https://remoteineurope.com${href}`,
        source_url: `https://remoteineurope.com${href}`,
        location,
        remote_type: "fully_remote",
        job_type: "full_time",
        category: cat,
        published_at: publishedAt,
      });
    }

    return jobs;
  }
}
