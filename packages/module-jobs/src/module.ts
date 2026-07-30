import { z } from "zod";
import { defineModule, repoRelativePathSchema } from "@endoxa/core";

/**
 * Config for @endoxa/module-jobs. `criteria` points at a markdown file whose
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
    commands: { jobs: () => import("./cli") },
    indexRules: { dirAnchors: ["status.md"] },
    cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all" }],
  }),
});
