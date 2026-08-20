/**
 * Board adapters that only exist after JavaScript runs.
 *
 * These three sites (BuiltIn, NoDesk, Dice) used to be implemented TWICE: once
 * here as HTTP adapters that returned Cloudflare challenge pages or empty
 * markup, and once in a `browser-scrape.ts` with its own inline site registry,
 * its own hand-rolled CDP-over-WebSocket client, and its own copy of the
 * ingest path. `needsBrowser` existed on the adapter interface the whole time
 * and only one of the two paths honoured it.
 *
 * Now there is one implementation per site, `needsBrowser` decides how it is
 * served, and the browser itself comes from `@schlessera/brain-scrape` — the
 * same session type any other module would use.
 *
 * The page functions in the adapters below are TYPED FUNCTIONS, not the
 * strings they used to be. They are still serialized across the CDP boundary,
 * so they must close over nothing; what changed is that the compiler and the
 * linter can now see them.
 */
import type { ScrapeContext } from "@schlessera/brain-scrape";

import { BaseAdapter } from "./base.js";
import type { RawJob, ScrapeOptions } from "../types.js";

/** What a page function yields. Deliberately loose — pages are messy. */
export interface BrowserJobRecord {
  title?: string;
  company?: string;
  href?: string;
  location?: string;
  salary?: string;
  empType?: string;
  remote_type?: RawJob["remote_type"];
}

export abstract class BrowserAdapter extends BaseAdapter {
  override needsBrowser = true;

  /** Pages to visit this run. Query-driven boards build these from `queries`. */
  protected abstract urls(opts: ScrapeOptions & { queries?: string[] }): string[];
  /** Awaited before extraction — covers slow loads and challenge pages. */
  protected abstract readonly readySelector: string;
  /** Runs inside the page. Must close over nothing. */
  protected abstract extract(): BrowserJobRecord[];

  private browser(ctx: ScrapeContext) {
    if (!ctx.browser) {
      throw new Error(`${this.name} needs a browser and none is available`);
    }
    return ctx.browser;
  }

  async scrape(opts: ScrapeOptions & { lastCursor?: string; queries?: string[] }) {
    const errors: string[] = [];
    const jobs: RawJob[] = [];
    const seen = new Set<string>();
    const browser = this.browser(this.ctx);

    for (const url of this.urls(opts)) {
      try {
        if (opts.verbose) console.log(`[${this.source}] Opening: ${url}`);
        const records = await browser.load<BrowserJobRecord[]>({
          url,
          waitForSelector: this.readySelector,
          extract: this.extract,
        });

        if (!Array.isArray(records)) {
          errors.push(`${url}: extractor returned non-array`);
          continue;
        }
        if (records.length === 0) {
          // Worth an error rather than silence: an empty page almost always
          // means the selectors drifted or a challenge page was served, and
          // both look identical to "this board had no jobs today".
          errors.push(`${url}: 0 jobs extracted — selector drift or challenge page?`);
        }

        for (const record of records) {
          const id = record.href || `${record.company}-${record.title}`;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          jobs.push(this.toRawJob(record, id));
        }
        if (opts.verbose) console.log(`[${this.source}] ${records.length} jobs from ${url}`);
      } catch (err) {
        errors.push(`${url}: ${err}`);
      }
    }

    return this.makeResult(jobs, errors);
  }

  /** The one place a page record becomes a job. Was duplicated in the old path. */
  private toRawJob(record: BrowserJobRecord, id: string): RawJob {
    return {
      source: this.source,
      source_id: id,
      title: record.title || "",
      company: record.company || "Unknown",
      url: record.href,
      source_url: record.href,
      location: record.location || "Remote",
      remote_type: record.remote_type || "fully_remote",
      job_type: record.empType?.toLowerCase().includes("contract") ? "contract" : "full_time",
      salary_raw: record.salary || undefined,
      salary_currency: record.salary ? "USD" : undefined,
    };
  }
}
