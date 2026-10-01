import type { FetchOptions, SiteAdapter, AdapterStatus } from "@schlessera/brain-scrape";

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
] as const;
export type Source = (typeof ALL_SOURCES)[number];
/** The module schema's initial selection, independent of per-run CLI defaults. */
export const DEFAULT_JOB_BOARDS: readonly Source[] = ["remoteok"];

/**
 * Boards with an adapter that are NOT enabled by default, and why. Every board
 * in `ALL_SOURCES` is either here or in `SOURCES`, never both — a test holds
 * the two lists to that, so neither can drift from the other. Any of these can
 * be enabled per run, e.g. `jobs scrape nodesk --proxy "..."`, or permanently
 * via the module `boards` config, unless its reason says otherwise.
 */
export const DISABLED_BY_DEFAULT = {
  nodesk: "client-rendered; needs a browser",
  dice: "client-rendered; needs a browser",
  builtin: "client-rendered; needs a browser",
  // The 403s #33 measured were rate limiting: the same URL answered 200
  // fifteen minutes later.
  simplyhired:
    "intermittent 403s (rate limiting) from the measured vantage point; see tests/fixtures/boards/README.md",
  // The API answers cleanly since #35; the limit is politeness, not a block.
  jobgether:
    "robots.txt disallows its API's query-string paging, so a run gets one page; see docs/decisions/scraping-politeness.md",
  // robots.txt disallows /api/*, and /api/remote-jobs is the only path the
  // adapter fetches, so every request is refused before it is sent. Enabling
  // it changes nothing without the site's permission: the adapter stays for
  // whoever has that, and `allowDisallowed` is deliberately not set for it.
  remotive:
    "robots.txt disallows /api/*, the only path its adapter fetches; it needs the site's permission before it can run",
} as const satisfies Partial<Record<Source, string>>;

// Sources enabled by default: the ones that work reliably without a headless
// browser or proxy. The rest are in `DISABLED_BY_DEFAULT`, with their reasons.
export const SOURCES = [
  "remoteok",
  "weworkremotely",
  "workingnomads",
  "remotelyde",
] as const satisfies readonly Source[];

/**
 * Boards that used to exist and are gone, with the reason a user is shown.
 *
 * Kept so a scrape or a `boards` config naming one is told the board was
 * retired, rather than "Unknown source" — the name was real, and an existing
 * brain's config may still carry it.
 */
export const RETIRED_SOURCES: Readonly<Record<string, string>> = {
  remoteineurope:
    "remoteineurope.com is no longer a job board; every page answers a redirect to weworkremotely.com, " +
    "which is scraped as `weworkremotely`",
};

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

/**
 * What a board's run was, beyond the number of rows it produced.
 *
 * The count on its own is not a health signal, and that is the whole of #37:
 * `remoteineurope` reported 0 found and 0 errors for months while its domain
 * 301ed to another site, which reads exactly like a board that had no jobs
 * that day. So the adapter says which of four things happened, and a consumer
 * branches on that rather than on a number:
 *
 * - `ok` — rows came out. Pages that drifted still show up in `errors`.
 * - `empty` — every page that arrived said, in the board's own terms, that it
 *   holds no postings. A zero that means zero.
 * - `unparseable` — a page arrived, did not say it was empty, and yielded
 *   nothing. Selector drift, a challenge page, or markup from another site.
 * - `not_run` — nothing readable arrived at all: the adapter was never
 *   invoked, or every page it tried failed before a body could be parsed
 *   (robots.txt refusal, HTTP 410, no Chrome). The errors say which.
 *
 * `empty` is the only one of the four that is allowed to carry no errors, and
 * an adapter may only claim it from a positive signal — see `PageLedger.read`.
 */
export const SOURCE_STATUSES = ["ok", "empty", "unparseable", "not_run"] as const;
export type SourceStatus = AdapterStatus;

/**
 * Job metadata composed onto the shared adapter contract, not a second lifecycle.
 * @experimental The `SiteAdapter` seam remains experimental until 1.0.
 */
export interface JobAdapter extends SiteAdapter<RawJob> {
  readonly id: Source;
  readonly source: Source;
  readonly tier: 1 | 2 | 3;
  /** Per-board pacing/headers for enrichment, kept in the jobs domain. */
  readonly detailFetchOptions?: FetchOptions;
  /** Enrichment follows source_url only on these board-owned hosts. */
  readonly detailHosts?: readonly string[];
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
