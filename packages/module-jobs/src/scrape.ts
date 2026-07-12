import { Database } from "bun:sqlite";
import { openDatabase, getLastCursor, logScrapeRun } from "./db";
import { computeFingerprint, normalizeCompany, normalizeTitle, runDedup } from "./dedup";
import { scoreNewJobs, autoClassify, type ScoringConfig } from "./score";
import type { RawJob, ScrapeResult, Source } from "./types";
import { SOURCES, EUR_RATES } from "./types";
import { stripHtml } from "./html";

// Adapter registry
import { RemoteOKAdapter } from "./adapters/remoteok";
import { RemotiveAdapter } from "./adapters/remotive";
import { WeWorkRemotelyAdapter } from "./adapters/weworkremotely";
import { WorkingNomadsAdapter } from "./adapters/workingnomads";
import { BuiltInAdapter } from "./adapters/builtin";
import { NodeskAdapter } from "./adapters/nodesk";
import { SimplyHiredAdapter } from "./adapters/simplyhired";
import { JobgetherAdapter } from "./adapters/jobgether";
import { DiceAdapter } from "./adapters/dice";
import { RemotelyDeAdapter } from "./adapters/remotelyde";
import { RemoteInEuropeAdapter } from "./adapters/remoteineurope";
import type { ScraperAdapter } from "./types";

// The two query-driven boards accept the user's search terms; the rest fetch
// full feeds or fixed category pages and ignore `queries`.
const ADAPTERS: Record<Source, (queries?: string[]) => ScraperAdapter> = {
  remoteok: () => new RemoteOKAdapter(),
  remotive: () => new RemotiveAdapter(),
  weworkremotely: () => new WeWorkRemotelyAdapter(),
  workingnomads: () => new WorkingNomadsAdapter(),
  builtin: () => new BuiltInAdapter(),
  nodesk: () => new NodeskAdapter(),
  simplyhired: (queries) => new SimplyHiredAdapter(queries),
  jobgether: () => new JobgetherAdapter(),
  dice: (queries) => new DiceAdapter(queries),
  remotelyde: () => new RemotelyDeAdapter(),
  remoteineurope: () => new RemoteInEuropeAdapter(),
};

export function getAdapter(source: Source, queries?: string[]): ScraperAdapter {
  const factory = ADAPTERS[source];
  if (!factory) throw new Error(`Unknown source: ${source}`);
  return factory(queries);
}

export interface ScrapeReport {
  sources: Array<{
    source: Source;
    jobs_found: number;
    jobs_new: number;
    jobs_updated: number;
    errors: string[];
    duration_ms: number;
  }>;
  dedup: { checked: number; duplicates_found: number };
  scored: number;
  total_new: number;
  total_errors: string[];
}

export async function runScrape(opts: {
  /** Absolute path to the jobs database. */
  dbPath: string;
  sources?: Source[];
  /** Search terms for query-driven boards (simplyhired, dice). */
  queries?: string[];
  /** Parsed criteria; when omitted, scoring/classification is skipped. */
  scoringConfig?: ScoringConfig | null;
  incremental?: boolean;
  proxy?: string;
  verbose?: boolean;
  dryRun?: boolean;
}): Promise<ScrapeReport> {
  const db = openDatabase(opts.dbPath);
  const sources = opts.sources ?? [...SOURCES];
  const incremental = opts.incremental !== false; // default true

  const report: ScrapeReport = {
    sources: [],
    dedup: { checked: 0, duplicates_found: 0 },
    scored: 0,
    total_new: 0,
    total_errors: [],
  };

  // 1. Run all adapters in parallel
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const start = Date.now();
      const adapter = getAdapter(source, opts.queries);
      const lastCursor = incremental ? getLastCursor(db, source) : null;

      logScrapeRun(db, source, "running");

      try {
        const result = await adapter.scrape({
          incremental,
          lastCursor: lastCursor ?? undefined,
          proxy: opts.proxy,
          verbose: opts.verbose,
          dryRun: opts.dryRun,
        });
        return { source, result, duration_ms: Date.now() - start, lastCursor };
      } catch (err) {
        return {
          source,
          result: { source, jobs: [], errors: [`${err}`], cursor: undefined } as ScrapeResult,
          duration_ms: Date.now() - start,
          lastCursor,
        };
      }
    })
  );

  // 2. Ingest results
  for (const settled of results) {
    if (settled.status === "rejected") {
      report.total_errors.push(`Adapter failed: ${settled.reason}`);
      continue;
    }

    const { source, result, duration_ms, lastCursor } = settled.value;
    const ingestStats = opts.dryRun
      ? { new: result.jobs.length, updated: 0 }
      : ingestJobs(db, result.jobs, opts.verbose);

    // Log completed run
    if (!opts.dryRun) {
      // Only persist an advanced cursor when the adapter completed with ZERO
      // errors. A partially-failed run keeps the previous cursor so the failed
      // window is re-fetched next run — re-fetching is cheap and the upsert
      // handles repeats.
      const cursorToPersist =
        result.errors.length === 0 ? result.cursor : lastCursor ?? undefined;
      logScrapeRun(db, source, result.errors.length > 0 && result.jobs.length === 0 ? "failed" : "completed", {
        jobs_found: result.jobs.length,
        jobs_new: ingestStats.new,
        jobs_updated: ingestStats.updated,
        error: result.errors.length > 0 ? result.errors.join("; ") : undefined,
        cursor: cursorToPersist,
      });
    }

    report.sources.push({
      source,
      jobs_found: result.jobs.length,
      jobs_new: ingestStats.new,
      jobs_updated: ingestStats.updated,
      errors: result.errors,
      duration_ms,
    });

    report.total_new += ingestStats.new;
    report.total_errors.push(...result.errors);
  }

  if (!opts.dryRun) {
    // 3. Dedup pass
    report.dedup = runDedup(db, opts.verbose);

    // 4. Score new jobs + auto-classify (only when criteria are available)
    if (opts.scoringConfig) {
      report.scored = scoreNewJobs(db, opts.scoringConfig, opts.verbose);
      autoClassify(db, opts.scoringConfig);
    }
  }

  db.close();
  return report;
}

export interface IngestStats {
  new: number;
  updated: number;
}

export function ingestJobs(db: Database, jobs: RawJob[], verbose = false): IngestStats {
  const stats: IngestStats = { new: 0, updated: 0 };
  if (jobs.length === 0) return stats;

  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO jobs (
      source, source_id, fingerprint,
      title, title_normalized, company, company_normalized,
      description, description_text, url, source_url,
      location, remote_type, job_type, category, tags,
      salary_min, salary_max, salary_raw, salary_currency,
      published_at, expires_at, first_seen_at, last_seen_at, scraped_at
    ) VALUES (
      $source, $source_id, $fingerprint,
      $title, $title_normalized, $company, $company_normalized,
      $description, $description_text, $url, $source_url,
      $location, $remote_type, $job_type, $category, $tags,
      $salary_min, $salary_max, $salary_raw, $salary_currency,
      $published_at, $expires_at, $now, $now, $now
    )
    ON CONFLICT(source, source_id) DO UPDATE SET
      last_seen_at = $now,
      scraped_at = $now,
      title = COALESCE($title, title),
      description = COALESCE($description, description),
      description_text = COALESCE($description_text, description_text),
      url = COALESCE($url, url),
      location = COALESCE($location, location),
      salary_min = COALESCE($salary_min, salary_min),
      salary_max = COALESCE($salary_max, salary_max),
      salary_raw = COALESCE($salary_raw, salary_raw)
  `);

  // FTS index is kept in sync manually (external-content FTS5 has no
  // automatic sync): insert on new rows, delete+reinsert when an existing
  // row's indexed content changes.
  const insertFts = db.prepare(
    "INSERT INTO jobs_fts(rowid, title, company, description_text, tags) VALUES (?, ?, ?, ?, ?)"
  );
  const deleteFts = db.prepare("DELETE FROM jobs_fts WHERE rowid = ?");

  const transaction = db.transaction(() => {
    for (const job of jobs) {
      if (!job.source_id || !job.title || !job.company) continue;

      const companyNorm = normalizeCompany(job.company);
      const titleNorm = normalizeTitle(job.title);
      const fingerprint = computeFingerprint(job.company, job.title, {
        source: job.source,
        sourceId: job.source_id,
      });

      // Strip HTML for plain text
      const descText = job.description ? stripHtml(job.description) : null;

      // Convert salary to EUR cents
      const { salaryMin, salaryMax } = convertSalary(
        job.salary_min,
        job.salary_max,
        job.salary_currency
      );

      const tagsJson = job.tags ? JSON.stringify(job.tags) : null;

      // Check if exists (fetch FTS-indexed columns to detect content drift)
      const existing = db
        .query(
          "SELECT id, title, company, description_text, tags FROM jobs WHERE source = ? AND source_id = ?"
        )
        .get(job.source, job.source_id) as {
        id: number;
        title: string;
        company: string;
        description_text: string | null;
        tags: string | null;
      } | null;

      // The ON CONFLICT clause only updates title/description_text among the
      // FTS-indexed columns (company/tags are never updated). Compute the
      // post-upsert values to detect whether the FTS row must be rebuilt.
      const effectiveDesc = existing ? descText ?? existing.description_text : descText;
      const contentChanged =
        existing !== null &&
        (existing.title !== job.title || existing.description_text !== effectiveDesc);

      // Delete the stale FTS row BEFORE the upsert — external-content FTS5
      // resolves the removed values from the jobs row, which must still hold
      // the old (indexed) values at that point.
      if (contentChanged && existing) deleteFts.run(existing.id);

      upsert.run({
        $source: job.source,
        $source_id: job.source_id,
        $fingerprint: fingerprint,
        $title: job.title,
        $title_normalized: titleNorm,
        $company: job.company,
        $company_normalized: companyNorm,
        $description: job.description ?? null,
        $description_text: descText,
        $url: job.url ?? null,
        $source_url: job.source_url ?? null,
        $location: job.location ?? null,
        $remote_type: job.remote_type ?? "unknown",
        $job_type: job.job_type ?? "unknown",
        $category: job.category ?? null,
        $tags: tagsJson,
        $salary_min: salaryMin,
        $salary_max: salaryMax,
        $salary_raw: job.salary_raw ?? null,
        $salary_currency: job.salary_currency ?? null,
        $published_at: job.published_at ?? null,
        $expires_at: job.expires_at ?? null,
        $now: now,
      });

      if (existing) {
        stats.updated++;
        // Reinsert the FTS row with the post-upsert values (company/tags are
        // not touched by the conflict clause, so the existing values apply).
        if (contentChanged) {
          insertFts.run(existing.id, job.title, existing.company, effectiveDesc, existing.tags);
        }
      } else {
        stats.new++;
        // Get the new row id for FTS
        const newRow = db
          .query("SELECT id FROM jobs WHERE source = ? AND source_id = ?")
          .get(job.source, job.source_id) as { id: number } | null;
        if (newRow) {
          insertFts.run(newRow.id, job.title, job.company, descText, tagsJson);
        }
      }
    }
  });

  transaction();
  return stats;
}

function convertSalary(
  min: number | undefined | null,
  max: number | undefined | null,
  currency: string | undefined | null
): { salaryMin: number | null; salaryMax: number | null } {
  if (!min && !max) return { salaryMin: null, salaryMax: null };

  const rate = EUR_RATES[currency?.toUpperCase() ?? "USD"] ?? EUR_RATES.USD;

  return {
    salaryMin: min ? Math.round(min * rate * 100) : null,
    salaryMax: max ? Math.round(max * rate * 100) : null,
  };
}
