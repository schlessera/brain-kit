import type { ScrapeContext } from "@schlessera/brain-scrape";

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
// browser or proxy). Disabled: nodesk, dice (client-rendered, need a browser);
// simplyhired, jobgether, builtin (Cloudflare 403 or empty responses). Any of
// these can be re-enabled per run, e.g. `jobs scrape nodesk --proxy "..."`, or
// permanently via the module `boards` config.
export const SOURCES = [
  "remoteok",
  "remotive",
  "weworkremotely",
  "workingnomads",
  "remotelyde",
  "remoteineurope",
] as const satisfies readonly Source[];

/**
 * Boards that only exist after JavaScript runs, and therefore need Chrome.
 *
 * They used to be a second scrape pipeline with its own site registry, its own
 * CDP client and its own ingest path. They are ordinary adapters now — this
 * list exists only so `--browser` / `--browser-only` can still select them.
 */
export const BROWSER_SOURCES = ["builtin", "nodesk", "dice"] as const satisfies readonly Source[];

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
  /** Decides whether this adapter is handed a browser or an HTTP client. */
  readonly needsBrowser: boolean;
  readonly needsProxy: boolean;
  /** Receive the run's shared scrape context. Called before `scrape()`. */
  bind(ctx: ScrapeContext): this;
  scrape(
    opts: ScrapeOptions & { lastCursor?: string; queries?: string[] }
  ): Promise<ScrapeResult>;
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
