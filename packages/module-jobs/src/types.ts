// All known source identifiers (adapters exist for all)
export const ALL_SOURCES = [
  "remoteok",
  "remotive",
  "weworkremotely",
  "workingnomads",
  "builtin",
  "nodesk",
  "simplyhired",
  "jobgether",
  "dice",
  "remotelyde",
  "remoteineurope",
] as const;
export type Source = (typeof ALL_SOURCES)[number];

// Sources enabled by default (ones that work reliably without a headless
// browser or proxy).
//
// nodesk, dice, jobgether and builtin were previously excluded here as
// "client-rendered, need a browser" or "Cloudflare 403". That is no longer
// true: all four serve their listings and their per-job detail pages to a
// plain HTTP client. Their adapters fetch detail pages directly, so they no
// longer depend on the Chrome pass to produce complete records.
//
// simplyhired stays out of the default set: it responds, but its adapter still
// yields listing-level records only (no description).
export const SOURCES = [
  "remoteok",
  "remotive",
  "weworkremotely",
  "workingnomads",
  "remotelyde",
  "remoteineurope",
  "builtin",
  "nodesk",
  "jobgether",
  "dice",
] as const satisfies readonly Source[];

export const REVIEW_STATUSES = [
  "pending",
  "queued",
  "interested",
  "starred",
  "dismissed",
  "archived",
  "applied",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface RawJob {
  source: Source;
  source_id: string;
  title: string;
  company: string;
  description?: string;
  url?: string;
  source_url?: string;
  location?: string;
  remote_type?: "fully_remote" | "hybrid" | "onsite" | "unknown";
  job_type?: "full_time" | "contract" | "part_time" | "unknown";
  category?: string;
  tags?: string[];
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
  salary_raw?: string;
  published_at?: string;
  expires_at?: string;
}

export interface ScrapeResult {
  source: Source;
  jobs: RawJob[];
  cursor?: string;
  errors: string[];
}

export interface ScrapeOptions {
  incremental?: boolean;
  proxy?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface ScraperAdapter {
  readonly source: Source;
  readonly name: string;
  readonly tier: 1 | 2 | 3;
  readonly needsBrowser: boolean;
  readonly needsProxy: boolean;
  scrape(opts: ScrapeOptions & { lastCursor?: string }): Promise<ScrapeResult>;
}

/**
 * A score breakdown is keyed by the user's own scoring-group names (from the
 * criteria file frontmatter), plus the synthetic `location` and `compensation`
 * dimensions and the `total`. See score.ts / the criteria template.
 */
export type ScoreBreakdown = Record<string, number> & { total: number };

export interface JobRow {
  id: number;
  source: Source;
  source_id: string;
  fingerprint: string;
  title: string;
  title_normalized: string;
  company: string;
  company_normalized: string;
  description: string | null;
  description_text: string | null;
  url: string | null;
  source_url: string | null;
  location: string | null;
  remote_type: string | null;
  job_type: string | null;
  category: string | null;
  tags: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_raw: string | null;
  salary_currency: string | null;
  published_at: string | null;
  expires_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  scraped_at: string;
  relevance_score: number;
  score_breakdown: string | null;
  scored_at: string | null;
  review_status: ReviewStatus;
  reviewed_at: string | null;
  review_notes: string | null;
  is_duplicate: number;
  duplicate_of: number | null;
}

// Currency conversion to EUR (approximate, for filtering only). Ingested
// salaries are normalized to EUR minor units (cents) so a single benchmark can
// compare postings across currencies.
export const EUR_RATES: Record<string, number> = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.16,
  CHF: 1.04,
  PLN: 0.23,
  CZK: 0.041,
  SEK: 0.088,
  NOK: 0.086,
  DKK: 0.134,
  CAD: 0.67,
  AUD: 0.60,
  INR: 0.011,
  JPY: 0.0061,
  CNY: 0.13,
  KRW: 0.00067,
  BRL: 0.16,
};
