/**
 * Detail-page enrichment (#36): a row its listing did not describe is followed
 * to the job's own page, and the description is taken from the `JobPosting`
 * structured data there.
 *
 * What it will and will not fetch is the whole design:
 *
 * - **Only rows with no description.** A description the listing carried (the
 *   RemoteOK, Remotive, Working Nomads and We Work Remotely feeds) is kept, and
 *   so is one an earlier run stored: the upsert keeps it over a null, so
 *   fetching the page again would spend a request and the cap on nothing.
 * - **The board's own page, and only that.** `source_url`, and only when its
 *   host is one the adapter names in `detailHosts`. Never `url`: on boards
 *   that have one it is the apply link, somebody else's site. A board that
 *   names no detail hosts is never enriched, so a feed URL pointing
 *   anywhere cannot send enrichment off the board.
 * - **Once per posting.** Rows with the same `(source, source_id)` are one
 *   stored row, so they cost one request and count once — and if any of them
 *   already has a description, none is fetched, since the upsert would let
 *   the fetched one overwrite it.
 * - **Through the run's one `ScrapeClient`,** so robots.txt and the per-host
 *   rate limiter decide every detail request exactly as they decide listing
 *   requests. Enrichment adds a floor between requests to one host
 *   (`DEFAULT_DETAIL_DELAY_MS`, or the board's own `detailFetchOptions`); it
 *   never schedules a request itself.
 * - **Bounded twice.** `concurrency` caps the detail requests in flight across
 *   every board at once, and `maxDetailPages` caps how many one run fetches.
 *   Rows past the cap are counted and reported, never skipped in silence.
 *
 * A detail page that fails, or carries no description, costs the row nothing:
 * it is stored as the listing gave it, and the failure is counted. Only the
 * description is taken, as the page serves it: `ingestJobs` strips it once,
 * as it does a feed's. Stripping it here as well would decode `&lt;10ms` into
 * a tag-shaped `<10ms` that the second strip deletes. The detail page's other fields are not trusted over
 * the listing's: jobgether's `datePosted`, for one, is a JavaScript
 * `Date.toString()` where its listing's is ISO (#36).
 *
 * The reported numbers are findings about the rows, not about whether the
 * board could be read, so they never move a board's `status` (#37).
 */
import {
  Semaphore,
  extractJsonLd,
  hostOf,
  jsonLdByType,
  stripHtml,
  type FetchOptions,
  type ScrapeClient,
} from "@schlessera/brain-scrape";

import type { RawJob, Source } from "./types.js";

export interface EnrichmentConfig {
  /** Detail requests in flight at once, across every board in the run. */
  concurrency: number;
  /** Detail pages one run fetches at most. 0 turns enrichment off. */
  maxDetailPages: number;
}

export const DEFAULT_ENRICHMENT: EnrichmentConfig = { concurrency: 4, maxDetailPages: 100 };

/**
 * The least time between two detail requests to one host, when the board asks
 * for nothing more. Listing runs fetch a handful of pages; enrichment fetches
 * one per row, which is exactly the burst a site's operator notices, so it is
 * spaced even where robots.txt names no `Crawl-delay`.
 */
export const DEFAULT_DETAIL_DELAY_MS = 2000;

/** How many individual failures one board's summary line quotes. */
const QUOTED_FAILURES = 3;

export interface EnrichmentStats {
  /** Rows that got a description from their detail page. */
  enriched: number;
  /** Detail pages fetched that failed, or that carried no description. */
  failed: number;
  /** Rows that wanted a detail page and were left out by the run's cap. */
  truncated: number;
  /** One line per finding, for the board's `errors`. */
  errors: string[];
}

export interface BoardEnrichment {
  source: Source;
  /** The board's display name, which prefixes its report lines. */
  name: string;
  /** The board's rows. Enriched rows are updated in place. */
  jobs: RawJob[];
  /** True for a row already stored with a description. */
  isDescribed?: (job: RawJob) => boolean;
  /** The board's own fetch options for its detail pages. */
  fetchOptions?: FetchOptions;
  /**
   * The hosts this board's own job pages live on. A row is followed only
   * when its `source_url` is on one of them (or a subdomain of one); a board
   * that names none is not enriched.
   */
  detailHosts?: readonly string[];
}

export interface Enricher {
  /** One board. The cap it can spend is whatever the run has left. */
  enrich(board: BoardEnrichment): Promise<EnrichmentStats>;
  /**
   * Every board of a run at once, with the cap dealt out round-robin — one
   * row per board per round — so no board's detail pages are starved by the
   * boards whose listings happened to finish first. Stats come back in the
   * order the boards were given.
   */
  enrichAll(boards: BoardEnrichment[]): Promise<EnrichmentStats[]>;
}

/** What one board wants fetched, and what it was granted. */
interface BoardPlan {
  board: BoardEnrichment;
  /** One entry per posting; `jobs` holds every row that shares its identity. */
  wanted: Array<{ jobs: RawJob[]; url: string }>;
  granted: number;
}

/** The part of an error worth quoting: its first line, not a whole HTML body. */
function brief(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n")[0].split(": <")[0];
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** The board's own page for a row: an absolute `source_url` on one of its hosts. */
function detailUrl(job: RawJob, hosts: readonly string[]): string | undefined {
  const candidate = job.source_url;
  if (!candidate || !/^https?:\/\//i.test(candidate)) return undefined;
  const host = hostOf(candidate).toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? candidate : undefined;
}

/**
 * Whether a description says anything once it is text — what `ingestJobs`
 * stores. `<p>&nbsp;</p>` is not a description, from a page or from a feed.
 */
function hasText(description: string | undefined): boolean {
  return !!description && stripHtml(description).trim().length > 0;
}

/** The first `JobPosting` description on a page that has text, as served. */
function postingDescription(html: string): string | undefined {
  for (const posting of jsonLdByType(extractJsonLd(html).documents, "JobPosting")) {
    const value = posting.description;
    if (typeof value === "string" && hasText(value)) return value;
  }
  return undefined;
}

/**
 * One enricher per run: the semaphore and the cap are shared by every board
 * the run enriches, however many run at once.
 */
export function createEnricher(
  http: Pick<ScrapeClient, "getPage">,
  config: Partial<EnrichmentConfig> = {}
): Enricher {
  const concurrency = Math.max(1, Math.floor(config.concurrency ?? DEFAULT_ENRICHMENT.concurrency));
  const maxDetailPages = Math.max(0, Math.floor(config.maxDetailPages ?? DEFAULT_ENRICHMENT.maxDetailPages));
  const slots = new Semaphore(concurrency);
  let remaining = maxDetailPages;

  function plan(board: BoardEnrichment): BoardPlan {
    const hosts = (board.detailHosts ?? []).map((host) => host.toLowerCase());
    // Every row of a posting first, so a described row anywhere in the group
    // is seen before the group is judged.
    const groups = new Map<string, RawJob[]>();
    for (const job of board.jobs) {
      const group = groups.get(job.source_id);
      if (group) group.push(job);
      else groups.set(job.source_id, [job]);
    }
    const wanted: BoardPlan["wanted"] = [];
    for (const jobs of groups.values()) {
      if (jobs.some((job) => hasText(job.description))) continue;
      const url = jobs.map((job) => detailUrl(job, hosts)).find(Boolean);
      if (!url) continue;
      if (board.isDescribed?.(jobs[0])) continue;
      wanted.push({ jobs, url });
    }
    return { board, wanted, granted: 0 };
  }

  /**
   * Deal the remaining cap out one row per board per round. Claimed up front
   * and synchronously, so two calls in flight cannot both spend the same
   * last page.
   */
  function allocate(plans: BoardPlan[]): void {
    let dealt = true;
    while (remaining > 0 && dealt) {
      dealt = false;
      for (const entry of plans) {
        if (remaining === 0) break;
        if (entry.granted < entry.wanted.length) {
          entry.granted++;
          remaining--;
          dealt = true;
        }
      }
    }
  }

  async function fetchPlan({ board, wanted, granted: count }: BoardPlan): Promise<EnrichmentStats> {
    const stats: EnrichmentStats = { enriched: 0, failed: 0, truncated: 0, errors: [] };
    const granted = wanted.slice(0, count);
    stats.truncated = wanted.length - granted.length;

    const failures: string[] = [];
    await Promise.all(
      granted.map(async ({ jobs, url }) => {
        const release = await slots.acquire();
        try {
          const page = await http.getPage(url, {
            delayMs: DEFAULT_DETAIL_DELAY_MS,
            ...board.fetchOptions,
          });
          const description = postingDescription(page.body);
          if (!description) {
            stats.failed++;
            failures.push(`${url}: no JobPosting description on the page`);
            return;
          }
          for (const job of jobs) job.description = description;
          stats.enriched++;
        } catch (err) {
          stats.failed++;
          failures.push(`${url}: ${brief(err)}`);
        } finally {
          release();
        }
      })
    );

    if (stats.failed > 0) {
      const quoted = failures.slice(0, QUOTED_FAILURES).join("; ");
      const more = failures.length > QUOTED_FAILURES ? `; and ${failures.length - QUOTED_FAILURES} more` : "";
      stats.errors.push(
        `${board.name}: ${stats.failed} of ${granted.length} detail pages gave no description ` +
          `(stored without one): ${quoted}${more}`
      );
    }
    if (stats.truncated > 0) {
      stats.errors.push(
        `${board.name}: ${stats.truncated} jobs left without a description — ` +
          `the run's cap of ${maxDetailPages} detail pages was reached`
      );
    }
    return stats;
  }

  const off = (): EnrichmentStats => ({ enriched: 0, failed: 0, truncated: 0, errors: [] });

  async function enrichAll(boards: BoardEnrichment[]): Promise<EnrichmentStats[]> {
    // Off is a setting, not a truncation, so it reports nothing.
    if (maxDetailPages === 0) return boards.map(off);
    const plans = boards.map(plan);
    allocate(plans);
    return Promise.all(plans.map(fetchPlan));
  }

  return {
    enrich: async (board) => (await enrichAll([board]))[0],
    enrichAll,
  };
}
