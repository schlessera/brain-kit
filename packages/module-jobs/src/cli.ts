import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandContext, CommandModule } from "@schlessera/brain";
import { safeResolve } from "@schlessera/brain";

import { openDatabase } from "./db.js";
import { runScrape } from "./scrape.js";
import {
  loadScoringConfig,
  scoreMaxes,
  scoreNewJobs,
  rescoreAllJobs,
  autoClassify,
  type ScoringConfig,
} from "./score.js";
import {
  getReviewQueue,
  getJobById,
  getDuplicatesOf,
  setReviewStatus,
  getStats,
  searchJobs,
  formatJobSummary,
  formatJobDetail,
} from "./review.js";
import { runInteractiveReview, openUrl } from "./interactive-review.js";
import { ALL_SOURCES, BROWSER_SOURCES, RETIRED_SOURCES, REVIEW_STATUSES, SOURCES } from "./types.js";
import type { ReviewStatus, Source } from "./types.js";
import type { JobsConfig } from "./module.js";

// ---------------------------------------------------------------------------
// Resolution: config + taxonomy + paths from the brain root
// ---------------------------------------------------------------------------

interface JobsCtx {
  root: string;
  json: boolean;
  config: JobsConfig;
  dbPath: string;
  opportunitiesDir: string;
  criteriaPath: string;
}

async function resolveJobsCtx(ctx: CommandContext<JobsConfig>): Promise<JobsCtx> {
  // ctx.config is the loader-validated block, typed by the module contract;
  // ctx.taxonomy the merged taxonomy. No re-loading of brain.config (the old
  // reload path silently fell back to schema defaults on any error), and no
  // re-parse — the loader already applied the schema and its defaults.
  const jobsConfig = ctx.config;

  const opportunitiesDir = ctx.taxonomy.dirForType("opportunity") ?? jobsConfig.opportunitiesDir;
  // dbPath is schema-constrained to a repo-relative path; safeResolve also
  // refuses a symlinked component pointing outside the root.
  const dbPath = safeResolve(ctx.root, jobsConfig.dbPath ?? "jobs.db");
  if (!dbPath) throw new Error(`jobs dbPath escapes the brain root: ${jobsConfig.dbPath}`);

  return {
    root: ctx.root,
    json: ctx.json,
    config: jobsConfig,
    dbPath,
    opportunitiesDir,
    criteriaPath: jobsConfig.criteria,
  };
}

/** Load the scoring config, or return null (with a warning) when unavailable. */
function tryLoadScoring(jctx: JobsCtx, required: boolean): ScoringConfig | null {
  try {
    return loadScoringConfig(jctx.root, jctx.criteriaPath);
  } catch (err) {
    const msg = (err as Error).message;
    if (required) throw err;
    if (!jctx.json) console.warn(`Warning: scoring skipped — ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function makeArgs(args: string[]) {
  return {
    flag: (name: string) => args.includes(`--${name}`),
    option: (name: string): string | undefined => {
      const idx = args.indexOf(`--${name}`);
      return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
    },
    positionals: (from = 1) => {
      const out: string[] = [];
      for (let i = from; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) {
          // skip the value of value-taking options
          if (["proxy", "status", "source", "min-score", "limit", "days", "notes"].includes(a.slice(2))) i++;
          continue;
        }
        out.push(a);
      }
      return out;
    },
  };
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * Which boards a scrape runs: explicit positionals > `--all` > the configured
 * `boards` > the default `SOURCES`, then the browser selectors on top.
 *
 * `warnings` are printed and the run goes ahead; an `error` refuses the run.
 */
export function selectSources(input: {
  positional: string[];
  configured: string[];
  all?: boolean;
  browser?: boolean;
  browserOnly?: boolean;
}): { sources: Source[]; warnings: string[] } | { error: string; warnings: string[] } {
  const warnings: string[] = [];
  const known = (name: string): name is Source => (ALL_SOURCES as readonly string[]).includes(name);
  const retired = (name: string): boolean => Object.hasOwn(RETIRED_SOURCES, name);
  const retiredMessage = (name: string): string => `${name} was retired: ${RETIRED_SOURCES[name]}.`;

  // Asked for by name, a retired board refuses the run: skipping it would
  // bury the answer in a scrape summary.
  const retiredRequested = input.positional.filter(retired);
  if (retiredRequested.length > 0) {
    return { error: retiredRequested.map(retiredMessage).join("\n"), warnings };
  }

  // Named in config, it warns and the rest runs, so a scheduled scrape does not
  // stop over a config written before the board was retired.
  for (const name of input.configured.filter(retired)) {
    warnings.push(`${retiredMessage(name)} Remove it from the jobs module's \`boards\` config.`);
  }

  const requested = input.positional.filter(known);
  if (input.positional.length > 0 && requested.length === 0) {
    return { error: `Unknown sources: ${input.positional.join(", ")}. Valid: ${ALL_SOURCES.join(", ")}`, warnings };
  }

  const configured = input.configured.filter(known);
  const base: Source[] =
    requested.length > 0
      ? requested
      : input.all
        ? [...ALL_SOURCES]
        : configured.length > 0
          ? configured
          : [...SOURCES];
  const sources: Source[] = input.browserOnly
    ? [...BROWSER_SOURCES]
    : input.browser
      ? [...new Set([...base, ...BROWSER_SOURCES])]
      : base;
  return { sources, warnings };
}

async function cmdScrape(args: string[], jctx: JobsCtx): Promise<number> {
  const a = makeArgs(args);
  const verbose = a.flag("verbose");
  const dryRun = a.flag("dry-run");
  const full = a.flag("full");
  const all = a.flag("all");
  // Browser boards are ordinary sources now — `needsBrowser` on the adapter is
  // what makes them different, and the runner supplies a browser when one of
  // the selected boards wants it. These two flags survive as source SELECTORS
  // (they used to select a second, parallel scrape pipeline).
  const browserOnly = a.flag("browser-only");
  const browser = a.flag("browser") || browserOnly;
  const proxy = a.option("proxy");

  const selection = selectSources({
    positional: a.positionals(),
    configured: jctx.config.boards,
    all,
    browser,
    browserOnly,
  });
  for (const warning of selection.warnings) console.error(warning);
  if ("error" in selection) {
    console.error(selection.error);
    return 1;
  }
  const { sources } = selection;

  const scoringConfig = tryLoadScoring(jctx, false);

  if (!jctx.json) {
    console.log(
      `Scraping ${sources.join(", ")}${full ? " (full)" : " (incremental)"}${dryRun ? " [DRY RUN]" : ""}...`
    );
  }

  const report = await runScrape({
    dbPath: jctx.dbPath,
    sources,
    queries: jctx.config.queries,
    scoringConfig,
    incremental: !full,
    proxy,
    verbose,
    dryRun,
    rates: jctx.config.rates,
  });

  if (jctx.json) {
    emitJson({ report });
    return 0;
  }

  console.log("\n--- Scrape Summary ---");
  for (const s of report.sources) {
    // The count is not the health signal — a board that parsed nothing and a
    // board that had nothing both say "0 found" — so the state is printed
    // whenever it is not a plain success. See SourceStatus.
    const state = s.status === "ok" ? "" : ` [${s.status}]`;
    const errors =
      s.errors.length > 0 ? ` (${s.errors.length} error${s.errors.length === 1 ? "" : "s"})` : "";
    console.log(
      `  ${s.source}: ${s.jobs_found} found, ${s.jobs_new} new, ${s.jobs_updated} updated (${s.duration_ms}ms)${state}${errors}`
    );
  }
  if (report.dedup.duplicates_found > 0) console.log(`\nDedup: ${report.dedup.duplicates_found} duplicates found`);
  if (report.scored > 0) console.log(`Scored: ${report.scored} jobs`);
  console.log(`Total new: ${report.total_new}`);
  if (report.total_errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of report.total_errors) console.log(`  - ${e}`);
  }

  if (!dryRun && report.total_new > 0) {
    const db = openDatabase(jctx.dbPath);
    const topJobs = getReviewQueue(db, { status: "queued", limit: 5 });
    if (topJobs.length > 0) {
      console.log(`\nTop queued jobs:`);
      topJobs.forEach((j, i) => console.log(formatJobSummary(j, i + 1)));
    }
    db.close();
  }
  return 0;
}


async function cmdScore(args: string[], jctx: JobsCtx): Promise<number> {
  const a = makeArgs(args);
  const verbose = a.flag("verbose");
  const rescore = a.flag("rescore") || a.flag("all");
  const reclassify = a.flag("reclassify");

  const scoringConfig = tryLoadScoring(jctx, true)!;
  const db = openDatabase(jctx.dbPath);

  let count: number;
  if (rescore) {
    count = rescoreAllJobs(db, scoringConfig, verbose);
    if (reclassify) {
      db.query(
        `UPDATE jobs SET review_status = 'pending' WHERE review_status = 'queued' AND reviewed_at IS NULL`
      ).run();
    }
    autoClassify(db, scoringConfig);
  } else {
    count = scoreNewJobs(db, scoringConfig, verbose);
    autoClassify(db, scoringConfig);
  }

  const queued = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE review_status = 'queued'").get() as { c: number }).c;
  db.close();

  if (jctx.json) emitJson({ scored: count, queued });
  else console.log(`${rescore ? "Rescored" : "Scored"} ${count} jobs; ${queued} queued`);
  return 0;
}

async function cmdTriage(args: string[], jctx: JobsCtx): Promise<number> {
  const a = makeArgs(args);
  const status = (a.option("status") as ReviewStatus | undefined) ?? "queued";
  const minScore = a.option("min-score") ? Number(a.option("min-score")) : undefined;
  const source = a.option("source") as Source | undefined;

  if (jctx.json || !process.stdin.isTTY) {
    // Interactive TUI needs a TTY; fall back to a plain listing.
    return cmdReview(["review", "--status", status, ...(minScore ? ["--min-score", String(minScore)] : [])], jctx);
  }

  const db = openDatabase(jctx.dbPath);
  const scoring = tryLoadScoring(jctx, false);
  const maxes = scoring ? scoreMaxes(scoring) : {};
  try {
    await runInteractiveReview(db, { status, minScore, source }, maxes);
    return 0;
  } catch (err) {
    console.error(`Triage failed: ${err}`);
    return 1;
  } finally {
    db.close();
  }
}

function cmdReview(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const status = a.flag("all") ? "all" : (a.option("status") as ReviewStatus | undefined) ?? "queued";
  const minScore = a.option("min-score") ? Number(a.option("min-score")) : undefined;
  const limit = a.option("limit") ? Number(a.option("limit")) : 20;
  const source = a.option("source") as Source | undefined;

  const db = openDatabase(jctx.dbPath);
  const jobs = getReviewQueue(db, { status: status as ReviewStatus | "all", minScore, limit, source });
  db.close();

  if (jctx.json) {
    emitJson({ jobs });
    return 0;
  }

  if (jobs.length === 0) {
    console.log("No jobs in review queue. Run 'scrape' first or adjust filters.");
    return 0;
  }

  const statusLabel = status === "all" ? "all statuses" : status;
  console.log(`Review Queue: ${jobs.length} jobs (${statusLabel})\n`);
  jobs.forEach((j, i) => {
    console.log(formatJobSummary(j, i + 1));
    console.log();
  });
  console.log(`Actions: jobs decide <id> interested|dismissed|applied`);
  console.log(`         jobs show <id>     (full description)`);
  console.log(`         jobs open <id>     (open in browser)`);
  return 0;
}

function cmdStats(jctx: JobsCtx): number {
  const db = openDatabase(jctx.dbPath);
  const stats = getStats(db);

  if (jctx.json) {
    const lastRuns = db
      .query(`SELECT source, MAX(started_at) AS last_run, status, jobs_found, error FROM scrape_runs GROUP BY source`)
      .all();
    db.close();
    emitJson({ stats, adapters: lastRuns });
    return 0;
  }

  console.log("=== Job Database Stats ===\n");
  console.log(`Total jobs: ${stats.total} (${stats.duplicates} duplicates)\n`);
  console.log("By Status:");
  for (const [status, count] of Object.entries(stats.by_status)) console.log(`  ${status}: ${count}`);
  console.log("\nBy Source:");
  for (const [source, count] of Object.entries(stats.by_source)) console.log(`  ${source}: ${count}`);
  console.log("\nScore Distribution:");
  for (const { range, count } of stats.score_distribution) {
    if (count === 0) continue;
    console.log(`  ${range}: ${"█".repeat(Math.min(count, 50))} ${count}`);
  }
  if (stats.recent_runs.length > 0) {
    console.log("\nRecent Scrape Runs:");
    for (const run of stats.recent_runs) {
      console.log(`  ${run.started_at.split("T")[0]} ${run.source}: ${run.status} (${run.jobs_found} found, ${run.jobs_new} new)`);
    }
  }

  const lastRuns = db
    .query(`SELECT source, MAX(started_at) AS last_run, status, jobs_found, error FROM scrape_runs GROUP BY source`)
    .all() as Array<{ source: string; last_run: string; status: string; jobs_found: number; error: string | null }>;
  const runBySource = new Map(lastRuns.map((r) => [r.source, r]));
  const enabledSources = SOURCES as readonly string[];
  console.log("\nAdapter Health:");
  for (const source of ALL_SOURCES) {
    const enabledTag = enabledSources.includes(source) ? "" : " [disabled by default]";
    const run = runBySource.get(source);
    if (!run) {
      console.log(`  ${source.padEnd(16)} never run${enabledTag}`);
      continue;
    }
    const when = run.last_run.replace("T", " ").slice(0, 16);
    let line = `  ${source.padEnd(16)} ${when}  ${run.status.padEnd(9)} ${run.jobs_found} found${enabledTag}`;
    if (run.error) {
      const err = run.error.length > 70 ? `${run.error.slice(0, 67)}...` : run.error;
      line += `\n${" ".repeat(20)}error: ${err}`;
    }
    console.log(line);
  }
  db.close();
  return 0;
}

function kebabCase(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cmdScaffold(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const id = Number(a.positionals()[0]);
  if (!id) {
    console.error("Usage: jobs scaffold <job-id>");
    return 1;
  }

  const db = openDatabase(jctx.dbPath);
  const job = getJobById(db, id);
  if (!job) {
    console.error(`Job #${id} not found`);
    db.close();
    return 1;
  }

  const slug = kebabCase(job.company) || `job-${job.id}`;
  // Scraped company names feed the slug — keep the scaffold inside the root.
  const dir = safeResolve(jctx.root, join(jctx.opportunitiesDir, slug));
  if (dir === null) {
    console.error(`Scaffold path escapes the brain root: ${slug}`);
    db.close();
    return 1;
  }
  if (existsSync(dir)) {
    console.error(`Refusing to scaffold: directory already exists: ${dir}`);
    db.close();
    return 1;
  }

  const today = new Date().toISOString().split("T")[0];
  const escapeQuotes = (s: string) => s.replace(/"/g, '\\"');

  let salary: string | null = null;
  if (job.salary_raw) salary = job.salary_raw;
  else if (job.salary_min || job.salary_max) {
    const min = job.salary_min ? `€${Math.round(job.salary_min / 100).toLocaleString()}` : "?";
    const max = job.salary_max ? `€${Math.round(job.salary_max / 100).toLocaleString()}` : "?";
    salary = `${min} - ${max} (EUR, annual)`;
  }

  let scoreLine = `${Math.round(job.relevance_score)}/100`;
  if (job.score_breakdown) {
    try {
      const bd = JSON.parse(job.score_breakdown) as Record<string, number>;
      const parts = Object.entries(bd)
        .filter(([key, val]) => key !== "total" && typeof val === "number" && val > 0)
        .map(([key, val]) => `${key.replace(/[-_]/g, " ")} ${val}`);
      if (parts.length > 0) scoreLine += ` (${parts.join(", ")})`;
    } catch {}
  }

  const url = job.url || job.source_url;
  const roleLines = [`- **Title:** ${job.title}`, `- **Company:** ${job.company}`];
  if (job.location) roleLines.push(`- **Location:** ${job.location}`);
  if (salary) roleLines.push(`- **Salary:** ${salary}`);
  if (url) roleLines.push(`- **Source URL:** ${url}`);
  roleLines.push(`- **Relevance score:** ${scoreLine}`);

  const content = `---
type: opportunity
title: "${escapeQuotes(job.company)} - ${escapeQuotes(job.title)}"
created: ${today}
updated: ${today}
tags: [opportunity, job-search, ${slug}]
status: active
relevance: primary
summary: "${escapeQuotes(`${job.title} at ${job.company}`)}"
---

## Role

${roleLines.join("\n")}

## Timeline

- ${today} — Scaffolded from job scraper (source: ${job.source}, job id ${job.id})

## Next Steps

- [TODO: review posting and decide whether to apply]
`;

  mkdirSync(dir, { recursive: true });
  const statusPath = resolve(dir, "status.md");
  writeFileSync(statusPath, content);

  setReviewStatus(db, job.id, "interested", `Scaffolded opportunity directory ${jctx.opportunitiesDir}/${slug}/ on ${today}`);
  db.close();

  if (jctx.json) {
    emitJson({ created: statusPath, slug, jobId: job.id, status: "interested" });
  } else {
    console.log(`Created: ${statusPath}`);
    console.log(`Job #${job.id} "${job.title}" @ ${job.company} -> interested`);
    console.log(`Reminder: add a row for ${job.company} to ${jctx.opportunitiesDir}/_index.md (not edited automatically)`);
  }
  return 0;
}

function cmdShow(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const id = Number(a.positionals()[0]);
  if (!id) {
    console.error("Usage: jobs show <id>");
    return 1;
  }
  const db = openDatabase(jctx.dbPath);
  const job = getJobById(db, id);
  if (!job) {
    console.error(`Job #${id} not found`);
    db.close();
    return 1;
  }
  if (jctx.json) {
    emitJson({ job, duplicates: getDuplicatesOf(db, id) });
    db.close();
    return 0;
  }
  console.log(formatJobDetail(job));
  const dupes = getDuplicatesOf(db, id);
  if (dupes.length > 0) {
    console.log(`\n--- Also found on ---`);
    for (const d of dupes) console.log(`  #${d.id} via ${d.source} (${d.source_url || d.url || "no URL"})`);
  }
  db.close();
  return 0;
}

function cmdOpen(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const id = Number(a.positionals()[0]);
  if (!id) {
    console.error("Usage: jobs open <id>");
    return 1;
  }
  const db = openDatabase(jctx.dbPath);
  const job = getJobById(db, id);
  db.close();
  if (!job) {
    console.error(`Job #${id} not found`);
    return 1;
  }
  const url = job.url || job.source_url;
  if (!url) {
    console.error("No URL available for this job");
    return 1;
  }
  console.log(`Opening: ${url}`);
  openUrl(url);
  return 0;
}

function cmdDecide(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const positional = a.positionals();
  const id = Number(positional[0]);
  const status = positional[1] as ReviewStatus;
  const notes = a.option("notes");
  if (!id || !status || !(REVIEW_STATUSES as readonly string[]).includes(status)) {
    console.error(`Usage: jobs decide <id> <${REVIEW_STATUSES.join("|")}> [--notes "text"]`);
    return 1;
  }
  const db = openDatabase(jctx.dbPath);
  const job = getJobById(db, id);
  if (!job) {
    console.error(`Job #${id} not found`);
    db.close();
    return 1;
  }
  setReviewStatus(db, id, status, notes);
  db.close();
  console.log(`Job #${id} "${job.title}" @ ${job.company} -> ${status}`);
  if (notes) console.log(`Notes: ${notes}`);
  return 0;
}

function cmdSearch(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const query = a.positionals().join(" ");
  if (!query) {
    console.error("Usage: jobs search <query> [--limit <n>]");
    return 1;
  }
  const limit = a.option("limit") ? Number(a.option("limit")) : 20;
  const db = openDatabase(jctx.dbPath);
  const results = searchJobs(db, query, limit);
  db.close();
  if (jctx.json) {
    emitJson({ query, results });
    return 0;
  }
  if (results.length === 0) {
    console.log(`No results for "${query}"`);
    return 0;
  }
  console.log(`Search results for "${query}": ${results.length} jobs\n`);
  results.forEach((j, i) => {
    console.log(formatJobSummary(j, i + 1));
    console.log();
  });
  return 0;
}

function cmdGc(args: string[], jctx: JobsCtx): number {
  const a = makeArgs(args);
  const daysOpt = a.option("days");
  const purge = a.flag("purge");
  const days = daysOpt ? Number(daysOpt) : 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const db = openDatabase(jctx.dbPath);
  const result = db
    .query(
      `UPDATE jobs SET review_status = 'dismissed', review_notes = COALESCE(review_notes || ' ', '') || '[stale: absent from scrape results since ' || last_seen_at || ']'
       WHERE last_seen_at < ? AND review_status = 'pending' AND is_duplicate = 0`
    )
    .run(cutoff);
  console.log(`GC: marked ${result.changes} stale jobs as dismissed (absent from scrape results for ${days}+ days)`);

  if (purge) {
    const purgeDays = daysOpt ? Number(daysOpt) : 90;
    const purgeCutoff = new Date(Date.now() - purgeDays * 24 * 60 * 60 * 1000).toISOString();
    const ids = db
      .query(`SELECT id FROM jobs WHERE (review_status = 'dismissed' OR is_duplicate = 1) AND last_seen_at < ?`)
      .all(purgeCutoff) as Array<{ id: number }>;
    if (ids.length === 0) {
      console.log(`Purge: nothing to delete (no dismissed/duplicate jobs older than ${purgeDays} days)`);
    } else {
      const delFts = db.prepare("DELETE FROM jobs_fts WHERE rowid = ?");
      const clearDupRef = db.prepare("UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of = ?");
      const delJob = db.prepare("DELETE FROM jobs WHERE id = ?");
      const purgeTx = db.transaction(() => {
        for (const { id } of ids) {
          delFts.run(id);
          clearDupRef.run(id);
          delJob.run(id);
        }
      });
      purgeTx();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      console.log(`Purge: hard-deleted ${ids.length} jobs (dismissed/duplicate, not seen in ${purgeDays}+ days)`);
    }
  }
  db.close();
  return 0;
}

// ---------------------------------------------------------------------------
// CommandModule entry
// ---------------------------------------------------------------------------

const HELP = `jobs — job-search pipeline (board scraping, scoring, dedup, triage)

Subcommands:
  scrape [sources...]     Run scrapers (configured boards if none given)
    --all                 Scrape every known API board
    --browser             ALSO run the headless-Chrome boards (builtin, nodesk,
                          dice) after the API pass — one unified run
    --browser-only        Run only the headless-Chrome boards
    --full                Force full re-scrape (ignore cursors)
    --dry-run             Fetch but don't persist
    --proxy <url>         Proxy URL for boards that need it
    --verbose             Detailed progress
  score                   Score unscored jobs against the criteria + classify
    --rescore | --all     Re-score every job
    --reclassify          Re-evaluate queued jobs after rescoring
  triage                  Interactive one-at-a-time review (TTY)
    --status <status>     Default: queued
  review                  List the review queue
    --all | --status <s> | --min-score <n> | --limit <n> | --source <s>
  stats                   Database + adapter-health statistics
  scaffold <id>           Create an opportunity dir from a job, mark interested
  show <id> | open <id> | decide <id> <status> | search <query> | gc [--purge]`;

const command: CommandModule<JobsConfig> = {
  summary: "Job-search pipeline: scrape boards, score, dedup, triage",
  helpBlock: HELP,
  async run(args, ctx) {
    const sub = args[0];
    if (!sub || sub === "help" || sub === "--help") {
      console.log(HELP);
      return 0;
    }

    const jctx = await resolveJobsCtx(ctx);

    switch (sub) {
      case "scrape":
        return cmdScrape(args, jctx);
      case "score":
      case "rescore":
        return cmdScore(sub === "rescore" ? [...args, "--rescore"] : args, jctx);
      case "triage":
        return cmdTriage(args, jctx);
      case "review":
        return cmdReview(args, jctx);
      case "stats":
        return cmdStats(jctx);
      case "scaffold":
        return cmdScaffold(args, jctx);
      case "show":
        return cmdShow(args, jctx);
      case "open":
        return cmdOpen(args, jctx);
      case "decide":
        return cmdDecide(args, jctx);
      case "search":
        return cmdSearch(args, jctx);
      case "gc":
        return cmdGc(args, jctx);
      default:
        console.error(`Unknown jobs subcommand: ${sub}`);
        console.log(HELP);
        return 1;
    }
  },
};

export default command;
