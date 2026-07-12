import { z } from "zod";
import { defineModule } from "@brainform/core";

/**
 * Config for @brainform/module-jobs. `criteria` points at a markdown file whose
 * frontmatter defines the weighted scoring rules (see docs/criteria-template.md
 * and the README); it stays brain content the user owns and tunes.
 */
export const configSchema = z
  .object({
    /** Path (relative to the brain root) to the scoring criteria markdown file. */
    criteria: z.string(),
    /** Canonical directory for opportunity docs (scaffold target). */
    opportunitiesDir: z.string().default("career/opportunities"),
    /** Boards to scrape by default. */
    boards: z.array(z.string()).default(["remoteok"]),
    /** Search terms for the query-driven boards (simplyhired, dice). */
    queries: z
      .array(z.string())
      .default(["software engineer", "backend engineer", "platform engineer"]),
    /** Jobs database path; defaults to `<root>/jobs.db`. */
    dbPath: z.string().optional(),
  })
  .strict();

export type JobsConfig = z.infer<typeof configSchema>;

export default defineModule({
  name: "jobs",
  taxonomy: {
    // Static default dir. A default-exported manifest cannot read user config;
    // if you relocate `opportunitiesDir`, also override taxonomy.types.opportunity
    // in brain.config (see README).
    types: { opportunity: { dir: "career/opportunities" } },
  },
  commands: { jobs: () => import("./cli") },
  indexRules: { dirAnchors: ["status.md"] },
  cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all" }],
  configSchema,
});
