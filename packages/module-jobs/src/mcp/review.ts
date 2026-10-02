import { defineModuleTool, type ToolContext } from "@schlessera/brain";
import { z } from "zod";
import type { JobsConfig } from "../module.js";
import { reviewJobs } from "../review-operation.js";
import { projectJobSummary } from "../review.js";
import { ALL_SOURCES, REVIEW_STATUSES } from "../types.js";

export default defineModuleTool({
  description: "Read the jobs review queue, ordered by relevance then publication date. status defaults to queued and limit to 20. Return at most 50 jobs; larger positive limits are clamped to 50. Missing databases return an empty queue without being created.",
  inputSchema: z.strictObject({
    status: z.enum([...REVIEW_STATUSES, "all"]).default("queued").describe("Review status, or all statuses; defaults to queued"),
    min_score: z.number().optional().describe("Minimum relevance score, inclusive"),
    limit: z.number().int().positive().default(20).describe("Positive integer result limit; defaults to 20 and is clamped to 50"),
    source: z.enum(ALL_SOURCES).optional().describe("Limit the queue to one source board"),
  }),
  outputSchema: z.strictObject({ jobs: z.array(z.strictObject({
    id: z.number().int(), title: z.string(), company: z.string(), location: z.string().nullable(),
    remote_type: z.string().nullable(), salary_raw: z.string().nullable(),
    salary_min: z.number().nullable(), salary_max: z.number().nullable(), salary_currency: z.string().nullable(),
    source: z.string(), published_at: z.string().nullable(), review_status: z.enum(REVIEW_STATUSES),
    relevance_score: z.number(), tags: z.array(z.string()), url: z.string().nullable(),
  })) }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(input, ctx: ToolContext<JobsConfig>) {
    const jobs = reviewJobs(ctx.root, ctx.config, {
      status: input.status, minScore: input.min_score,
      limit: Math.min(input.limit, 50), source: input.source,
    });
    return { jobs: jobs.map(projectJobSummary) };
  },
});
