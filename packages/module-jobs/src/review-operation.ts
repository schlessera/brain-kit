import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { safeResolve } from "@schlessera/brain/module";
import { z } from "zod";
import { openDatabase } from "./db.js";
import type { JobsConfig } from "./module.js";
import { getReviewQueue, type ReviewOptions } from "./review.js";
import { ALL_SOURCES, REVIEW_STATUSES, type JobRow } from "./types.js";

const optionsSchema = z.strictObject({
  status: z.enum([...REVIEW_STATUSES, "all"]).optional(),
  minScore: z.number().optional(),
  limit: z.number().int().positive().default(20),
  source: z.enum(ALL_SOURCES).optional(),
  showDuplicates: z.boolean().optional(),
});

/** Shared CLI/MCP read: validate first, contain the path, and never create a database. */
export function reviewJobs(
  root: string,
  config: Pick<JobsConfig, "dbPath">,
  options: ReviewOptions = {}
): JobRow[] {
  const validated = optionsSchema.parse(options);
  const path = safeResolve(root, config.dbPath ?? "jobs.db");
  if (!path) throw new Error(`jobs dbPath escapes the brain root: ${config.dbPath}`);

  let db: Database;
  try {
    // OPEN_READWRITE without CREATE also protects against disappearing files. The
    // existing schema initialization/migration remains shared with the CLI.
    db = openDatabase(path, { create: false });
  } catch (error) {
    if (!existsSync(path)) return [];
    throw error;
  }
  try {
    return getReviewQueue(db, validated);
  } finally { db.close(); }
}
