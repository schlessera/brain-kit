/**
 * Dice — query-driven job search.
 *
 * Browser-only and query-driven: the search results are client-rendered, so
 * the HTTP adapter this replaces saw an empty shell. The default queries are
 * generic on purpose — a published package must not ship one person's job
 * search. Real queries come from the module's `queries` config.
 */
import { BrowserAdapter, type BrowserJobRecord } from "./browser-base.js";
import type { ScrapeOptions } from "../types.js";

const DEFAULT_QUERIES = ["software engineer", "backend engineer", "platform engineer"];

export class DiceAdapter extends BrowserAdapter {
  readonly source = "dice" as const;
  readonly name = "Dice";
  readonly tier = 2 as const;
  protected readonly readySelector = 'a[aria-label*="View Details for"]';

  constructor(private readonly configuredQueries?: string[]) {
    super();
  }

  protected urls(opts: ScrapeOptions & { queries?: string[] }): string[] {
    const queries =
      opts.queries?.length ? opts.queries
      : this.configuredQueries?.length ? this.configuredQueries
      : DEFAULT_QUERIES;
    return queries.map(
      (query) => `https://www.dice.com/jobs?q=${encodeURIComponent(query)}&filters.isRemote=true`
    );
  }

  /**
   * Runs INSIDE the page. Dice puts the title in an aria-label and everything
   * else in unlabelled sibling text, so the company/salary/type are recovered
   * by scanning the card's lines AFTER the title line and rejecting known
   * chrome.
   */
  protected extract(): BrowserJobRecord[] {
    const jobs: BrowserJobRecord[] = [];

    for (const link of document.querySelectorAll('a[aria-label*="View Details for"]')) {
      const label = link.getAttribute("aria-label") || "";
      const titleMatch = label.match(/View Details for (.+?)\s*\([a-f0-9]+\)$/);
      const title = titleMatch ? titleMatch[1] : "";
      const href = link.getAttribute("href") || "";
      if (!title || !href.includes("/job-detail/")) continue;

      const context =
        (link.parentElement?.parentElement as HTMLElement | null | undefined)?.innerText || "";
      const lines = context
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      let company = "";
      let salary = "";
      let empType = "";
      let foundTitle = false;
      for (const line of lines) {
        if (line.includes(title)) {
          foundTitle = true;
          continue;
        }
        if (!foundTitle) continue;
        if (
          !company &&
          line.length > 2 &&
          line.length < 80 &&
          !line.match(
            /^(Remote|Hybrid|On-site|Easy|Apply|View|Save|\$|Posted|Today|Yesterday|Full time|Contract|Part time|Third Party|Job Description)/i
          )
        ) {
          company = line;
          continue;
        }
        if (!salary && line.match(/\$[\d,]+/)) {
          salary = line;
          continue;
        }
        if (!empType && line.match(/^(Full time|Contract|Part time|Third Party)$/i)) {
          empType = line;
        }
      }

      jobs.push({ title, company, href, location: "Remote", salary, empType, remote_type: "fully_remote" });
    }
    return jobs;
  }
}
