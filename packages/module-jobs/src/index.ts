/**
 * @schlessera/brain-module-jobs public API.
 *
 * The manifest is the default export of "./module" (loaded by core via
 * `@schlessera/brain-module-jobs/module`). This entry re-exports the scoring engine
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
} from "./score.js";
export { openDatabase } from "./db.js";
export { runScrape, ingestJobs, getAdapter } from "./scrape.js";
export { scrapeSites } from "./browser-scrape.js";
export {
  getReviewQueue,
  getJobById,
  searchJobs,
  setReviewStatus,
  getStats,
} from "./review.js";
export type {
  RawJob,
  JobRow,
  ScoreBreakdown,
  Source,
  ReviewStatus,
  ScraperAdapter,
} from "./types.js";
export { ALL_SOURCES, SOURCES, REVIEW_STATUSES } from "./types.js";

export { default, configSchema, type JobsConfig } from "./module.js";
