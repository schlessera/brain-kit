/**
 * @schlessera/brain-module-jobs public API.
 *
 * The manifest is the default export of "./module" (loaded by core via
 * `@schlessera/brain-module-jobs/module`). This entry adds the board-adapter
 * composition (`JobAdapter`, `getAdapter`), the direct `runScrape` fallback
 * and the shapes the integration contract documents. Scoring, review and
 * database work is reached through `brain jobs` and the module's MCP tools.
 */

export {
  type ScoringConfig,
  type ScoringGroup,
  type ScoringTier,
  type LocationScoring,
} from "./score.js";
export { runScrape, getAdapter } from "./scrape.js";
export type { ScrapeReport } from "./scrape.js";
export type { JobSummary } from "./review.js";
export type {
  RawJob,
  JobRow,
  Source,
  SourceStatus,
  ReviewStatus,
  JobAdapter,
} from "./types.js";
export { ALL_SOURCES, REVIEW_STATUSES } from "./types.js";

export { default, configSchema, type JobsConfig } from "./module.js";

// Environment contract (chokepoint: src/config/env.ts).
export { ENV_VARS, resolveEnv } from "./config/env.js";
export type { EnvVarSpec, JobsEnv } from "./config/env.js";
