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
   * Runs INSIDE the page. Dice puts the title in an aria-label, the company
   * behind a `/company-profile/` link, and the salary and employment type in
   * unlabelled sibling text — so those last two are recovered by scanning the
   * card's lines AFTER the title line and rejecting known chrome.
   *
   * The card link is RELATIVE, unlike every other board's, and is resolved
   * here rather than stored raw (#129).
   */
  protected extract(): BrowserJobRecord[] {
    const jobs: BrowserJobRecord[] = [];

    for (const link of document.querySelectorAll('a[aria-label*="View Details for"]')) {
      const label = link.getAttribute("aria-label") || "";
      const titleMatch = label.match(/View Details for (.+?)\s*\([a-f0-9]+\)$/);
      const title = titleMatch ? titleMatch[1] : "";
      const path = link.getAttribute("href") || "";
      if (!title || !path.includes("/job-detail/")) continue;

      const card =
        (link.closest('[data-testid="job-card"]') as HTMLElement | null) ||
        (link.parentElement?.parentElement as HTMLElement | null | undefined);
      const lines = (card?.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      // The company link comes before the line scan on purpose: scanning left
      // 10 of 102 rows at "Unknown" in the #33 run, and the logo link that
      // shares this selector has no text, so the first non-empty one wins.
      let company = "";
      for (const named of card?.querySelectorAll(
        '[data-testid="job-card-company-name"], a[href^="/company-profile/"]'
      ) || []) {
        const text = (named as HTMLElement).textContent?.trim() || "";
        if (text) {
          company = text;
          break;
        }
      }

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

      jobs.push({
        title,
        company,
        // The path, not the resolved URL: it is what `source_id` falls back
        // to, and every Dice row already stored is keyed by it.
        id: path,
        href: path.startsWith("http") ? path : `https://www.dice.com${path}`,
        location: "Remote",
        salary,
        empType,
        remote_type: "fully_remote",
      });
    }
    return jobs;
  }
}
