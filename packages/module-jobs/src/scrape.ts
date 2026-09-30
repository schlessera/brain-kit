import { Database } from "bun:sqlite";
import { openDatabase, getLastCursor, logScrapeRun } from "./db.js";
import { computeFingerprint, isIdentifiableCompany, normalizeCompany, normalizeTitle, runDedup } from "./dedup.js";
import { scoreNewJobs, autoClassify, type ScoringConfig } from "./score.js";
import {
  ScrapeClient,
  createBrowserSession,
  stripHtml,
  type BrowserSession,
  type ScrapeContext,
} from "@schlessera/brain-scrape";

import { resolveEnv as resolveScrapeEnv } from "@schlessera/brain-scrape";
import { resolveEnv } from "./config/env.js";
import type { RawJob, ScrapeResult, Source, SourceStatus } from "./types.js";
import { SOURCES } from "./types.js";
import { eurRates } from "./salary.js";
import { createEnricher, type EnrichmentConfig, type EnrichmentStats } from "./enrich.js";

// Adapter registry
import { RemoteOKAdapter } from "./adapters/remoteok.js";
import { RemotiveAdapter } from "./adapters/remotive.js";
import { WeWorkRemotelyAdapter } from "./adapters/weworkremotely.js";
import { WorkingNomadsAdapter } from "./adapters/workingnomads.js";
import { BuiltInAdapter } from "./adapters/builtin.js";
import { NodeskAdapter } from "./adapters/nodesk.js";
import { SimplyHiredAdapter } from "./adapters/simplyhired.js";
import { JobgetherAdapter } from "./adapters/jobgether.js";
import { DiceAdapter } from "./adapters/dice.js";
import { RemotelyDeAdapter } from "./adapters/remotelyde.js";
import type { ScraperAdapter } from "./types.js";

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
};

export function getAdapter(source: Source, queries?: string[]): ScraperAdapter {
  const factory = ADAPTERS[source];
  if (!factory) throw new Error(`Unknown source: ${source}`);
  return factory(queries);
}

export interface ScrapeReport {
  sources: Array<{
    source: Source;
    /**
     * What the run WAS, which `jobs_found` on its own cannot say — see
     * `SourceStatus`. Every selected board gets an entry, including one whose
     * adapter never returned: it appears with `not_run` rather than vanishing
     * from the report.
     */
    status: SourceStatus;
    jobs_found: number;
    jobs_new: number;
    jobs_updated: number;
    /**
     * Rows that arrived with no description and got one from their own
     * detail page this run (#36). A row the listing already described, or
     * one stored with a description by an earlier run, is not fetched and is
     * not counted.
     */
    jobs_enriched: number;
    /** Detail pages fetched that failed, or that carried no description. */
    enrichment_failed: number;
    /**
     * Rows left without a description because the run's cap on detail pages
     * was reached before their turn. Never silent: `errors` says so too.
     */
    enrichment_truncated: number;
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
  /** Currency → EUR overrides from module config; see salary.ts. */
  rates?: Record<string, number>;
  /** Detail-page enrichment bounds; see enrich.ts. */
  enrichment?: Partial<EnrichmentConfig>;
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

  const adapters = sources.map((source) => getAdapter(source, opts.queries));
  // Two chokepoints: the scraping base owns SCRAPE_*, this module owns the
  // legacy CHROME_CDP_URL. SCRAPE_CHROME_URL wins when both are set.
  const env = resolveScrapeEnv();
  const chromeUrl = env.chromeUrl ?? resolveEnv().cdpUrl;

  // One client for the whole run, so the per-host rate limiter and the
  // robots.txt cache are shared by every board instead of each adapter
  // pacing itself in ignorance of the others.
  const http = new ScrapeClient({ userAgent: env.userAgent, respectRobots: env.respectRobots });

  // The browser is created only if some selected board needs one, and its
  // absence downgrades those boards rather than failing the run — a scheduled
  // scrape on a host without Chrome should lose the browser boards, not
  // everything.
  //
  // There is no try/catch here, and there used not to be a reason: this call
  // launches nothing, so it cannot fail, and the `Browser boards unavailable`
  // branch that used to wrap it was unreachable while reading like the thing
  // that handled a missing Chrome (#33's re-measurement, #37). What actually
  // reports it is `BrowserAdapter`, once per URL it could not open, which is
  // where the board's own name and the page are still in scope.
  let browser: BrowserSession | undefined;
  if (adapters.some((a) => a.needsBrowser)) {
    browser = createBrowserSession({
      browserUrl: chromeUrl,
      executablePath: env.chromePath,
      noSandbox: env.noSandbox,
      userAgent: env.userAgent,
      robots: http.robots,
      rateLimiter: http.rateLimiter,
    });
  }

  // One enricher for the whole run, so the concurrency limit and the cap on
  // detail pages hold across every board rather than per board.
  const enricher = createEnricher(http, opts.enrichment);
  const described = db.prepare(
    "SELECT 1 FROM jobs WHERE source = ? AND source_id = ? AND description_text IS NOT NULL AND description_text != ''"
  );
  const noEnrichment: EnrichmentStats = { enriched: 0, failed: 0, truncated: 0, errors: [] };

  const ctx: ScrapeContext = {
    http,
    browser,
    log: opts.verbose ? (message) => console.log(message) : () => {},
  };

  // 1. Run all adapters in parallel
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const source = adapter.source;
      const start = Date.now();
      const lastCursor = incremental ? getLastCursor(db, source) : null;

      logScrapeRun(db, source, "running");

      try {
        if (adapter.needsBrowser && !browser) {
          throw new Error("needs a browser and none is available");
        }
        const result = await adapter.bind(ctx).scrape({
          incremental,
          lastCursor: lastCursor ?? undefined,
          queries: opts.queries,
          proxy: opts.proxy,
          verbose: opts.verbose,
          dryRun: opts.dryRun,
        });
        return { source, adapter, result, duration_ms: Date.now() - start, lastCursor };
      } catch (err) {
        // The adapter threw before it could report anything, so nothing
        // readable arrived: `not_run`, with the throw as the reason.
        return {
          source,
          result: {
            source,
            jobs: [],
            errors: [`${err}`],
            cursor: undefined,
            status: "not_run",
          } as ScrapeResult,
          adapter,
          duration_ms: Date.now() - start,
          lastCursor,
        };
      }
    })
  );

  await browser?.close();

  // 2. Enrich every board's undescribed rows at once, after every listing is
  // in: the cap is dealt out across boards rather than spent by whichever
  // finished first. A dry run writes nothing, so it fetches no detail pages
  // for rows it would not store.
  const fulfilled = results.flatMap((settled) => (settled.status === "fulfilled" ? [settled.value] : []));
  const enrichments = new Map<(typeof fulfilled)[number], EnrichmentStats>();
  if (!opts.dryRun) {
    const stats = await enricher.enrichAll(
      fulfilled.map(({ source, adapter, result }) => ({
        source,
        name: adapter.name,
        jobs: result.jobs,
        isDescribed: (job) => described.get(job.source, job.source_id) !== null,
        // The run's proxy, where one was asked for, reaches the detail pages
        // the same way it reaches the listing.
        fetchOptions: { ...(opts.proxy ? { proxy: opts.proxy } : {}), ...adapter.detailFetchOptions },
        detailHosts: adapter.detailHosts,
      }))
    );
    fulfilled.forEach((value, index) => enrichments.set(value, stats[index]));
  }

  // 3. Ingest results
  for (const [index, settled] of results.entries()) {
    if (settled.status === "rejected") {
      // A board whose entry is missing from `sources` reads as one that was
      // never selected. It was: it was selected and it did not come back, so
      // it is reported as `not_run` rather than dropped.
      const source = sources[index];
      report.total_errors.push(`Adapter failed: ${settled.reason}`);
      report.sources.push({
        source,
        status: "not_run",
        jobs_found: 0,
        jobs_new: 0,
        jobs_updated: 0,
        jobs_enriched: 0,
        enrichment_failed: 0,
        enrichment_truncated: 0,
        errors: [`Adapter failed: ${settled.reason}`],
        duration_ms: 0,
      });
      continue;
    }

    const { source, result, duration_ms, lastCursor } = settled.value;
    const enrichment = enrichments.get(settled.value) ?? noEnrichment;
    // Enrichment findings are about the rows, not about whether the listing
    // could be read: they are reported alongside the board's errors but do
    // not hold back its cursor or its status (see `PageLedger.note`).
    const errors = [...result.errors, ...enrichment.errors];
    const ingestStats = opts.dryRun
      ? { new: result.jobs.length, updated: 0 }
      : ingestJobs(db, result.jobs, opts.verbose, opts.rates);

    // Log completed run
    if (!opts.dryRun) {
      // Only persist an advanced cursor when the adapter completed with ZERO
      // errors. A partially-failed run keeps the previous cursor so the failed
      // window is re-fetched next run — re-fetching is cheap and the upsert
      // handles repeats.
      const cursorToPersist =
        result.errors.length === 0 ? result.cursor : lastCursor ?? undefined;
      // A run that could not read the board is `failed` in the run log even
      // when it threw nothing — which is the point of #37. A recognised empty
      // listing is `completed`, so `getLastCursor` still advances past it.
      const runStatus =
        result.status === "ok" || result.status === "empty" ? "completed" : "failed";
      logScrapeRun(db, source, runStatus, {
        jobs_found: result.jobs.length,
        jobs_new: ingestStats.new,
        jobs_updated: ingestStats.updated,
        error: errors.length > 0 ? errors.join("; ") : undefined,
        cursor: cursorToPersist,
      });
    }

    report.sources.push({
      source,
      status: result.status,
      jobs_found: result.jobs.length,
      jobs_new: ingestStats.new,
      jobs_updated: ingestStats.updated,
      jobs_enriched: enrichment.enriched,
      enrichment_failed: enrichment.failed,
      enrichment_truncated: enrichment.truncated,
      errors,
      duration_ms,
    });

    report.total_new += ingestStats.new;
    report.total_errors.push(...errors);
  }

  if (!opts.dryRun) {
    // 4. Dedup pass
    report.dedup = runDedup(db, opts.verbose);

    // 5. Score new jobs + auto-classify (only when criteria are available)
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

export function ingestJobs(
  db: Database,
  jobs: RawJob[],
  verbose = false,
  rateOverrides?: Record<string, number>
): IngestStats {
  const rates = eurRates(rateOverrides);
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
      fingerprint = $fingerprint,
      title = COALESCE($title, title),
      title_normalized = $title_normalized,
      company = $company,
      company_normalized = $company_normalized,
      description = COALESCE($description, description),
      description_text = COALESCE($description_text, description_text),
      url = COALESCE($url, url),
      source_url = COALESCE($source_url, source_url),
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
  // A stored row that gains a description it did not have (#36: its detail
  // page was capped or failed on an earlier run) was scored on its title and
  // tags alone, and scoring only ever visits unscored rows. Clear the score so
  // this run's scoring pass sees the description, and hand an AUTOMATIC
  // queue/dismiss decision back to `autoClassify`. A decision a person made
  // carries `reviewed_at`, and is left alone.
  const rescoreDescribed = db.prepare(
    `UPDATE jobs SET scored_at = NULL,
       review_status = CASE
         WHEN reviewed_at IS NULL AND review_status IN ('queued', 'dismissed') THEN 'pending'
         ELSE review_status
       END
     WHERE id = ?`
  );
  // A row whose fingerprint moved has left one dedup group and may have joined
  // another. It is no longer a duplicate of anything; nothing that matched its
  // OLD fingerprint is a duplicate of it; and the group it joins must be
  // settled again, because a row older than that group's canonical takes its
  // place — leaving the group's marks would chain its duplicates to a
  // canonical that is now a duplicate itself. `runDedup`, which runs after
  // every ingest, regroups all three.
  const releaseRow = db.prepare("UPDATE jobs SET is_duplicate = 0, duplicate_of = NULL WHERE id = ?");
  const releaseDependants = db.prepare("UPDATE jobs SET is_duplicate = 0, duplicate_of = NULL WHERE duplicate_of = ?");
  // Only duplicates still attached to a canonical: a mark whose canonical was
  // deleted (`deleteJob`, `jobs gc --purge`) keeps the row hidden on purpose,
  // and regrouping must not bring it back into the review queue.
  const releaseGroup = db.prepare(
    "UPDATE jobs SET is_duplicate = 0, duplicate_of = NULL WHERE fingerprint = ? AND is_duplicate = 1 AND duplicate_of IS NOT NULL"
  );

  const transaction = db.transaction(() => {
    for (const job of jobs) {
      if (!job.source_id || !job.title || !job.company) continue;

      // Check if exists (fetch FTS-indexed columns to detect content drift)
      const existing = db
        .query(
          "SELECT id, fingerprint, title, company, description_text, tags FROM jobs WHERE source = ? AND source_id = ?"
        )
        .get(job.source, job.source_id) as {
        id: number;
        fingerprint: string;
        title: string;
        company: string;
        description_text: string | null;
        tags: string | null;
      } | null;

      // The conflict clause refreshes `company`, but `Unknown` (or nothing) is
      // an adapter saying it found no company on this card, not that the
      // company changed — so a stored row keeps a real company over it, the
      // way `COALESCE` keeps a column over a null.
      const company =
        existing && !isIdentifiableCompany(job.company) && isIdentifiableCompany(existing.company)
          ? existing.company
          : job.company;
      const companyNorm = normalizeCompany(company);
      const titleNorm = normalizeTitle(job.title);
      // Derived from the post-upsert company and title, so the stored
      // fingerprint always matches the row it sits on.
      const fingerprint = computeFingerprint(company, job.title, {
        source: job.source,
        sourceId: job.source_id,
      });

      // Strip HTML for plain text
      const descText = job.description ? stripHtml(job.description) : null;

      // Convert salary to EUR cents
      const { salaryMin, salaryMax } = convertSalary(
        job.salary_min,
        job.salary_max,
        job.salary_currency,
        rates
      );

      const tagsJson = job.tags ? JSON.stringify(job.tags) : null;

      // The ON CONFLICT clause updates title, company and description_text
      // among the FTS-indexed columns (tags are never updated). Compute the
      // post-upsert values to detect whether the FTS row must be rebuilt.
      const effectiveDesc = existing ? descText ?? existing.description_text : descText;
      const contentChanged =
        existing !== null &&
        (existing.title !== job.title ||
          existing.company !== company ||
          existing.description_text !== effectiveDesc);

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
        $company: company,
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
        // Reinsert the FTS row with the post-upsert values (tags are not
        // touched by the conflict clause, so the existing value applies).
        if (contentChanged) {
          insertFts.run(existing.id, job.title, company, effectiveDesc, existing.tags);
        }
        if (!existing.description_text?.trim() && effectiveDesc?.trim()) {
          rescoreDescribed.run(existing.id);
        }
        if (existing.fingerprint !== fingerprint) {
          releaseRow.run(existing.id);
          releaseDependants.run(existing.id);
          releaseGroup.run(fingerprint);
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
  currency: string | undefined | null,
  rates: Record<string, number> = eurRates()
): { salaryMin: number | null; salaryMax: number | null } {
  if (!min && !max) return { salaryMin: null, salaryMax: null };

  const rate = rates[currency?.toUpperCase() ?? "USD"] ?? rates.USD;

  return {
    salaryMin: min ? Math.round(min * rate * 100) : null,
    salaryMax: max ? Math.round(max * rate * 100) : null,
  };
}
