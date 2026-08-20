/**
 * Shared behaviour for the job-board adapters.
 *
 * Everything generic about scraping — the HTTP client, robots.txt, per-host
 * pacing, retries, HTML stripping, RSS parsing, the headless browser — now
 * lives in `@schlessera/brain-scrape`. What is left here is the part that is
 * actually about jobs: the `RawJob` shape and the `ScrapeResult` envelope.
 *
 * `bind()` is how an adapter receives its context. It is called by the runner
 * before `scrape()`, so an adapter never constructs a client and two adapters
 * never end up with two rate limiters for the same host.
 */
import { parseRssItems, stripHtml, type ScrapeContext } from "@schlessera/brain-scrape";

import type { RawJob, ScrapeResult, ScraperAdapter, Source } from "../types.js";

export abstract class BaseAdapter implements ScraperAdapter {
  abstract readonly source: Source;
  abstract readonly name: string;
  abstract readonly tier: 1 | 2 | 3;
  needsBrowser = false;
  needsProxy = false;

  /** Set by `bind()`; reading it before then is a runner bug, not a site bug. */
  protected ctx!: ScrapeContext;

  bind(ctx: ScrapeContext): this {
    this.ctx = ctx;
    return this;
  }

  /** The polite HTTP client for this run. */
  protected get http() {
    if (!this.ctx) {
      throw new Error(`${this.name} adapter was run without bind(ctx)`);
    }
    return this.ctx.http;
  }

  abstract scrape(
    opts: import("../types.js").ScrapeOptions & { lastCursor?: string }
  ): Promise<ScrapeResult>;

  protected stripHtml(html: string): string {
    return stripHtml(html);
  }

  protected parseRssItems(xml: string): Array<Record<string, string>> {
    return parseRssItems(xml);
  }

  protected makeResult(jobs: RawJob[], errors: string[], cursor?: string): ScrapeResult {
    return { source: this.source, jobs, errors, cursor };
  }
}
