/**
 * @endoxa/module-jobs public API.
 *
 * The manifest is the default export of "./module" (loaded by core via
 * `@endoxa/module-jobs/module`). This entry re-exports the scoring engine
 * and database helpers for embedders and tests.
 */

export {
  loadScoringConfig,
  parseScoringConfig,
  scoreJob,
  scoreNewJobs,
  rescoreAllJobs,
  autoClassify,
  scoreMaxes,
  type ScoringConfig,
  type ScoringGroup,
  type ScoringTier,
  type LocationScoring,
  type ScoreJobInput,
} from "./score";
export { openDatabase } from "./db";
export { runScrape, ingestJobs, getAdapter } from "./scrape";
export { scrapeSites } from "./browser-scrape";
export {
  getReviewQueue,
  getJobById,
  searchJobs,
  setReviewStatus,
  getStats,
} from "./review";
export type {
  RawJob,
  JobRow,
  ScoreBreakdown,
  Source,
  ReviewStatus,
  ScraperAdapter,
} from "./types";
export { ALL_SOURCES, SOURCES, REVIEW_STATUSES } from "./types";

export { default, configSchema, type JobsConfig } from "./module";
