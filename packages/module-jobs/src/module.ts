import { z } from "zod";
import { defineModule, repoRelativePathSchema } from "@schlessera/brain";
import { SOURCES } from "./types.js";

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
    /**
     * Boards to scrape by default.
     *
     * Defaults to the full set of boards known to work without a browser or
     * proxy (`SOURCES`). This must stay in sync with that list rather than
     * carrying its own literal: `cmdScrape` treats a non-empty configured
     * `boards` as authoritative, so a hardcoded default here silently shadows
     * `SOURCES` and a normal `brain jobs scrape` never sees the other boards.
     */
    boards: z.array(z.string()).default([...SOURCES]),
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
    skills: "./skills",
    commands: { jobs: () => import("./cli.js") },
    indexRules: { dirAnchors: ["status.md"] },
    // One unified run: `--browser` appends the headless-Chrome pass to the API
    // pass, and skips it cleanly when no Chrome is reachable — so a host
    // without Chrome loses the browser boards, not the whole scrape.
    cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all --browser" }],
  }),
});
