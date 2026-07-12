import { Database } from "bun:sqlite";
import type { JobRow, ReviewStatus, Source } from "./types";

export interface ReviewOptions {
  status?: ReviewStatus | "all";
  minScore?: number;
  limit?: number;
  source?: Source;
  showDuplicates?: boolean;
}

export function getReviewQueue(db: Database, opts: ReviewOptions = {}): JobRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (!opts.showDuplicates) {
    conditions.push("is_duplicate = 0");
  }

  if (opts.status && opts.status !== "all") {
    conditions.push("review_status = ?");
    params.push(opts.status);
  } else if (!opts.status) {
    // Default: show queued jobs
    conditions.push("review_status = 'queued'");
  }

  if (opts.minScore !== undefined) {
    conditions.push("relevance_score >= ?");
    params.push(opts.minScore);
  }

  if (opts.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 20;

  const query = `
    SELECT * FROM jobs
    ${where}
    ORDER BY relevance_score DESC, published_at DESC
    LIMIT ${limit}
  `;

  return db.query(query).all(...params) as JobRow[];
}

export function getJobById(db: Database, id: number): JobRow | null {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
}

export function getDuplicatesOf(db: Database, id: number): JobRow[] {
  return db.query("SELECT * FROM jobs WHERE duplicate_of = ?").all(id) as JobRow[];
}

export function setReviewStatus(
  db: Database,
  id: number,
  status: ReviewStatus,
  notes?: string
): void {
  const now = new Date().toISOString();
  if (notes !== undefined) {
    db.query("UPDATE jobs SET review_status = ?, reviewed_at = ?, review_notes = ? WHERE id = ?").run(
      status,
      now,
      notes,
      id
    );
  } else {
    db.query("UPDATE jobs SET review_status = ?, reviewed_at = ? WHERE id = ?").run(status, now, id);
  }
}

export function getStats(db: Database): {
  total: number;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
  duplicates: number;
  score_distribution: { range: string; count: number }[];
  recent_runs: Array<{ source: string; started_at: string; status: string; jobs_found: number; jobs_new: number }>;
} {
  const total = (db.query("SELECT COUNT(*) as cnt FROM jobs").get() as { cnt: number }).cnt;
  const duplicates = (
    db.query("SELECT COUNT(*) as cnt FROM jobs WHERE is_duplicate = 1").get() as { cnt: number }
  ).cnt;

  // By status
  const statusRows = db
    .query("SELECT review_status, COUNT(*) as cnt FROM jobs WHERE is_duplicate = 0 GROUP BY review_status")
    .all() as Array<{ review_status: string; cnt: number }>;
  const by_status: Record<string, number> = {};
  for (const r of statusRows) by_status[r.review_status] = r.cnt;

  // By source
  const sourceRows = db
    .query("SELECT source, COUNT(*) as cnt FROM jobs GROUP BY source")
    .all() as Array<{ source: string; cnt: number }>;
  const by_source: Record<string, number> = {};
  for (const r of sourceRows) by_source[r.source] = r.cnt;

  // Score distribution
  const scoreRanges = [
    { range: "90-100", min: 90, max: 101 },
    { range: "80-89", min: 80, max: 90 },
    { range: "70-79", min: 70, max: 80 },
    { range: "60-69", min: 60, max: 70 },
    { range: "50-59", min: 50, max: 60 },
    { range: "40-49", min: 40, max: 50 },
    { range: "30-39", min: 30, max: 40 },
    { range: "20-29", min: 20, max: 30 },
    { range: "10-19", min: 10, max: 20 },
    { range: "0-9", min: 0, max: 10 },
  ];
  const score_distribution = scoreRanges.map(({ range, min, max }) => {
    const cnt = (
      db
        .query(
          "SELECT COUNT(*) as cnt FROM jobs WHERE is_duplicate = 0 AND relevance_score >= ? AND relevance_score < ?"
        )
        .get(min, max) as { cnt: number }
    ).cnt;
    return { range, count: cnt };
  });

  // Recent scrape runs
  const recent_runs = db
    .query(
      "SELECT source, started_at, status, jobs_found, jobs_new FROM scrape_runs ORDER BY started_at DESC LIMIT 10"
    )
    .all() as Array<{
    source: string;
    started_at: string;
    status: string;
    jobs_found: number;
    jobs_new: number;
  }>;

  return { total, by_status, by_source, duplicates, score_distribution, recent_runs };
}

export function deleteJob(db: Database, id: number): void {
  db.query("DELETE FROM jobs_fts WHERE rowid = ?").run(id);
  db.query("UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of = ?").run(id);
  db.query("DELETE FROM jobs WHERE id = ?").run(id);
}

/**
 * Make arbitrary user input safe for FTS5 MATCH: strip embedded double
 * quotes and wrap every whitespace-separated term in double quotes so FTS5
 * operators and syntax characters (`c++`, `AND`, `title:`) are treated as
 * plain tokens instead of crashing the query.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term)) // drop punctuation-only terms
    .map((term) => `"${term}"`)
    .join(" ");
}

export function searchJobs(db: Database, query: string, limit = 20): JobRow[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  return db
    .query(
      `SELECT j.* FROM jobs j
       JOIN jobs_fts fts ON j.id = fts.rowid
       WHERE jobs_fts MATCH ? AND j.is_duplicate = 0
       ORDER BY rank
       LIMIT ?`
    )
    .all(ftsQuery, limit) as JobRow[];
}

// Formatting helpers for terminal output

export function formatJobSummary(job: JobRow, rank?: number): string {
  const lines: string[] = [];
  const prefix = rank !== undefined ? `#${rank}` : "";
  const score = `[${Math.round(job.relevance_score)}]`;
  const idTag = `(id:${job.id})`;

  lines.push(`${prefix} ${score} ${job.title} ${idTag}`);

  const meta: string[] = [job.company];
  if (job.location) meta.push(job.location);
  if (job.salary_raw) meta.push(job.salary_raw);
  else if (job.salary_min || job.salary_max) {
    const min = job.salary_min ? `€${Math.round(job.salary_min / 100).toLocaleString()}` : "?";
    const max = job.salary_max ? `€${Math.round(job.salary_max / 100).toLocaleString()}` : "?";
    meta.push(`${min} - ${max}`);
  }
  lines.push(`     ${meta.join(" | ")}`);

  const info: string[] = [`Source: ${job.source}`];
  if (job.published_at) info.push(`Published: ${job.published_at.split("T")[0]}`);
  if (job.review_status !== "queued") info.push(`Status: ${job.review_status}`);
  lines.push(`     ${info.join(" | ")}`);

  if (job.tags) {
    try {
      const tags = JSON.parse(job.tags) as string[];
      if (tags.length > 0) lines.push(`     Tags: ${tags.slice(0, 8).join(", ")}`);
    } catch {}
  }

  if (job.url) lines.push(`     ${job.url}`);

  return lines.join("\n");
}

export function formatJobDetail(job: JobRow): string {
  const lines: string[] = [];
  lines.push(`=== Job #${job.id} ===`);
  lines.push(`Title:      ${job.title}`);
  lines.push(`Company:    ${job.company}`);
  lines.push(`Source:     ${job.source} (ID: ${job.source_id})`);
  lines.push(`Score:      ${Math.round(job.relevance_score)}/100`);
  lines.push(`Status:     ${job.review_status}`);
  lines.push(`Location:   ${job.location || "N/A"}`);
  lines.push(`Remote:     ${job.remote_type || "N/A"}`);
  lines.push(`Job Type:   ${job.job_type || "N/A"}`);
  lines.push(`Category:   ${job.category || "N/A"}`);

  if (job.salary_raw) {
    lines.push(`Salary:     ${job.salary_raw}`);
  } else if (job.salary_min || job.salary_max) {
    const min = job.salary_min ? `€${Math.round(job.salary_min / 100).toLocaleString()}` : "?";
    const max = job.salary_max ? `€${Math.round(job.salary_max / 100).toLocaleString()}` : "?";
    lines.push(`Salary:     ${min} - ${max} (EUR, annual)`);
  }

  if (job.tags) {
    try {
      const tags = JSON.parse(job.tags) as string[];
      if (tags.length > 0) lines.push(`Tags:       ${tags.join(", ")}`);
    } catch {}
  }

  if (job.published_at) lines.push(`Published:  ${job.published_at}`);
  if (job.expires_at) lines.push(`Expires:    ${job.expires_at}`);
  lines.push(`First seen: ${job.first_seen_at}`);
  lines.push(`Last seen:  ${job.last_seen_at}`);

  if (job.url) lines.push(`Apply URL:  ${job.url}`);
  if (job.source_url && job.source_url !== job.url) lines.push(`Source URL: ${job.source_url}`);

  if (job.score_breakdown) {
    try {
      const bd = JSON.parse(job.score_breakdown);
      lines.push(`\nScore Breakdown:`);
      for (const [key, val] of Object.entries(bd)) {
        if (key === "total") continue;
        const label = key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        lines.push(`  ${label}: ${val}`);
      }
    } catch {}
  }

  if (job.review_notes) lines.push(`\nNotes: ${job.review_notes}`);

  if (job.is_duplicate && job.duplicate_of) {
    lines.push(`\n[DUPLICATE of job #${job.duplicate_of}]`);
  }

  if (job.description_text) {
    lines.push(`\n--- Description ---`);
    // Truncate long descriptions
    const desc = job.description_text;
    lines.push(desc.length > 2000 ? desc.slice(0, 2000) + "\n[...truncated]" : desc);
  }

  return lines.join("\n");
}
