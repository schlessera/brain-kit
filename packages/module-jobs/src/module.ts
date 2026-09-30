import { z } from "zod";
import { defineModule, repoRelativePathSchema } from "@schlessera/brain";

import { checkOpportunityStages } from "./pipeline.js";

/**
 * Config for @schlessera/brain-module-jobs. `criteria` points at a markdown file whose
 * frontmatter defines the weighted scoring rules (see docs/criteria-template.md
 * and the README); it stays brain content the user owns and tunes.
 */
export const configSchema = z
  .object({
    /** Path (relative to the brain root) to the scoring criteria markdown file. */
    criteria: repoRelativePathSchema,
    /** Canonical directory for opportunity docs (scaffold target). */
    opportunitiesDir: repoRelativePathSchema.default("career/opportunities"),
    /** Boards to scrape by default. */
    boards: z.array(z.string()).default(["remoteok"]),
    /** Search terms for the query-driven boards (simplyhired, dice). */
    queries: z
      .array(z.string())
      .default(["software engineer", "backend engineer", "platform engineer"]),
    /** Jobs database path, relative to the brain root; defaults to `<root>/jobs.db`. */
    dbPath: repoRelativePathSchema.optional(),
    /**
     * Currency → EUR conversion rates, overriding the stale fallbacks the
     * package ships. Rates move; a released package cannot. Anyone who cares
     * about the comparison being accurate sets them here rather than waiting
     * for a version bump.
     */
    rates: z.record(z.string(), z.number().positive()).optional(),
    /**
     * Following listings to each job's own page for its description (#36).
     * `concurrency` bounds the detail requests in flight across the whole
     * run; `maxDetailPages` caps how many one run fetches, and 0 turns
     * enrichment off. Per-host pacing and robots.txt still apply to every
     * one of them.
     */
    enrichment: z
      .object({
        concurrency: z.number().int().min(1).default(4),
        maxDetailPages: z.number().int().min(0).default(100),
      })
      .strict()
      .default({ concurrency: 4, maxDetailPages: 100 }),
  })
  .strict();

export type JobsConfig = z.infer<typeof configSchema>;

export default defineModule({
  name: "jobs",
  configSchema,
  // Two-phase: the opportunity taxonomy dir follows the configured
  // opportunitiesDir instead of a static literal.
  setup: (config) => ({
    taxonomy: {
      types: { opportunity: { dir: config.opportunitiesDir } },
    },
    skills: "./skills",
    commands: { jobs: () => import("./cli.js") },
    indexRules: { dirAnchors: ["status.md"] },
    hygieneChecks: [(ctx) => checkOpportunityStages(ctx)],
    // Follow the same configured board selection as a manual scrape. Selected
    // browser boards get Chrome from their adapter's needsBrowser flag; the
    // schedule must not add boards that the user left out.
    cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape" }],
  }),
});
