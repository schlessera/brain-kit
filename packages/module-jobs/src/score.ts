import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { parseFrontmatter } from "./lib/frontmatter-parse.js";
import type { ScoreBreakdown } from "./types.js";
import { safeResolve } from "@schlessera/brain";

// ---------------------------------------------------------------------------
// Criteria model
//
// The scoring rules are NOT hard-coded here. They are parsed from the YAML
// frontmatter of the criteria markdown file (module config `criteria`, e.g.
// "career/opportunities/search-criteria.md"). This keeps the actual keyword
// lists as brain content the user owns and tunes; the engine is generic.
//
// Frontmatter shape (see docs/criteria-template.md):
//
//   scoring:
//     groups:
//       - name: distributed-systems     # becomes a key in the score breakdown
//         weight: 25                     # max points this group contributes
//         match: all                     # "all" (default) | "title"
//         titleBoost: 1.0                # multiplier when matched in the title
//         tiers:                         # graded lists, strongest first
//           - points: 25
//             keywords: [distributed systems, consensus]
//           - points: 15
//             keywords: [scalability, high availability]
//         keywords: [...]                # OR a flat list scoring full `weight`
//     location:
//       weight: 20
//       preferred: [remote, worldwide, europe]
//       excluded:  [us only, united states only]
//     excludeTitles: [sales, marketing, recruiter]
//     compensationBenchmark: 15000000    # optional; EUR minor units, annual
//     compensationWeight: 10
//     queueThreshold: 60
//     dismissThreshold: 35
// ---------------------------------------------------------------------------

export interface ScoringTier {
  points: number;
  keywords: string[];
}

export interface ScoringGroup {
  /** Group name — surfaces as a key in the score breakdown. */
  name: string;
  /** Maximum points the group can contribute. */
  weight: number;
  /** Which text to match against. */
  match: "all" | "title";
  /** Multiplier applied to a tier's points when a keyword matched the title. */
  titleBoost: number;
  /** Graded keyword lists, strongest first. Best matching tier wins. */
  tiers: ScoringTier[];
}

export interface LocationScoring {
  weight: number;
  preferred: string[];
  excluded: string[];
}

export interface ScoringConfig {
  groups: ScoringGroup[];
  location: LocationScoring | null;
  excludeTitles: string[];
  /** Annual benchmark in EUR minor units (cents); optional. */
  compensationBenchmark: number | null;
  compensationWeight: number;
  queueThreshold: number;
  dismissThreshold: number;
}

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new Error(`Invalid scoring criteria: ${msg}`);
}

function asStringArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    fail(`${where} must be a list of strings`);
  }
  return (v as string[]).map((s) => s.toLowerCase());
}

function parseGroup(raw: any, i: number): ScoringGroup {
  if (!raw || typeof raw !== "object") fail(`scoring.groups[${i}] must be a mapping`);
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) fail(`scoring.groups[${i}].name is required`);
  const weight = Number(raw.weight);
  if (!Number.isFinite(weight) || weight <= 0) fail(`scoring.groups[${i}].weight must be a positive number`);

  const match = raw.match === "title" ? "title" : "all";
  const titleBoost = raw.titleBoost === undefined ? 1 : Number(raw.titleBoost);
  if (!Number.isFinite(titleBoost) || titleBoost <= 0) fail(`scoring.groups[${i}].titleBoost must be a positive number`);

  let tiers: ScoringTier[];
  if (Array.isArray(raw.tiers)) {
    tiers = raw.tiers.map((t: any, j: number) => {
      const points = Number(t?.points);
      if (!Number.isFinite(points) || points < 0) fail(`scoring.groups[${i}].tiers[${j}].points must be a non-negative number`);
      return { points, keywords: asStringArray(t?.keywords, `scoring.groups[${i}].tiers[${j}].keywords`) };
    });
  } else {
    // Flat list: a single implicit tier worth the full weight.
    tiers = [{ points: weight, keywords: asStringArray(raw.keywords, `scoring.groups[${i}].keywords`) }];
  }
  if (tiers.every((t) => t.keywords.length === 0)) {
    fail(`scoring.groups[${i}] ("${name}") has no keywords`);
  }

  return { name, weight, match, titleBoost, tiers };
}

/** Parse and validate the `scoring` frontmatter of the criteria file. */
export function parseScoringConfig(scoring: unknown): ScoringConfig {
  if (!scoring || typeof scoring !== "object") {
    fail("the criteria file frontmatter must define a `scoring:` mapping");
  }
  const s = scoring as Record<string, any>;

  if (!Array.isArray(s.groups) || s.groups.length === 0) {
    fail("scoring.groups must be a non-empty list");
  }
  const groups = s.groups.map((g: any, i: number) => parseGroup(g, i));

  const names = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) fail(`duplicate scoring group name "${g.name}"`);
    names.add(g.name);
  }

  let location: LocationScoring | null = null;
  if (s.location !== undefined && s.location !== null) {
    const weight = Number(s.location.weight);
    if (!Number.isFinite(weight) || weight <= 0) fail("scoring.location.weight must be a positive number");
    location = {
      weight,
      preferred: asStringArray(s.location.preferred, "scoring.location.preferred"),
      excluded: asStringArray(s.location.excluded, "scoring.location.excluded"),
    };
  }

  const compensationBenchmark =
    s.compensationBenchmark === undefined || s.compensationBenchmark === null
      ? null
      : Number(s.compensationBenchmark);
  if (compensationBenchmark !== null && (!Number.isFinite(compensationBenchmark) || compensationBenchmark <= 0)) {
    fail("scoring.compensationBenchmark must be a positive number (EUR minor units)");
  }
  const compensationWeight = s.compensationWeight === undefined ? 0 : Number(s.compensationWeight);
  if (!Number.isFinite(compensationWeight) || compensationWeight < 0) {
    fail("scoring.compensationWeight must be a non-negative number");
  }

  const queueThreshold = s.queueThreshold === undefined ? 60 : Number(s.queueThreshold);
  const dismissThreshold = s.dismissThreshold === undefined ? 35 : Number(s.dismissThreshold);
  if (!Number.isFinite(queueThreshold) || !Number.isFinite(dismissThreshold)) {
    fail("scoring.queueThreshold / dismissThreshold must be numbers");
  }

  return {
    groups,
    location,
    excludeTitles: asStringArray(s.excludeTitles, "scoring.excludeTitles"),
    compensationBenchmark,
    compensationWeight,
    queueThreshold,
    dismissThreshold,
  };
}

/**
 * Load the scoring config from the criteria markdown file. `criteriaPath` is
 * resolved against `root` when relative. Throws a readable error when the file
 * is missing or the frontmatter is malformed.
 */
export function loadScoringConfig(root: string, criteriaPath: string, source?: unknown): ScoringConfig {
  if (source !== undefined) return parseScoringConfig(source);
  const savedPath = safeResolve(root, "settings/jobs.json");
  if (!savedPath) throw new Error("Jobs settings escape the brain root");
  if (existsSync(savedPath)) {
    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as Record<string, unknown>;
    if (saved.scoring !== undefined) return parseScoringConfig(saved.scoring);
  }
  const abs = isAbsolute(criteriaPath) ? criteriaPath : resolve(root, criteriaPath);
  if (!existsSync(abs)) {
    throw new Error(
      `Scoring criteria file not found: ${abs}\n` +
        `Create it (see the criteria template shipped with @schlessera/brain-module-jobs) ` +
        `or set the module "criteria" config to an existing file.`
    );
  }
  const { data } = parseFrontmatter(readFileSync(abs, "utf8"));
  return parseScoringConfig((data as Record<string, unknown>).scoring);
}

/** Max points per breakdown key — for progress bars / percentage displays. */
export function scoreMaxes(config: ScoringConfig): Record<string, number> {
  const maxes: Record<string, number> = {};
  for (const g of config.groups) maxes[g.name] = g.weight;
  if (config.location) maxes.location = config.location.weight;
  if (config.compensationBenchmark !== null) maxes.compensation = config.compensationWeight;
  return maxes;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matcher for location markers, so short/ambiguous tokens
 * ("uk", "eu", "cet") do not match inside other words ("Milwaukee" has "uk").
 */
function makeMarkerRegex(markers: string[]): RegExp | null {
  if (markers.length === 0) return null;
  return new RegExp(`\\b(?:${markers.map(escapeRegex).join("|")})\\b`, "i");
}

function groupScore(group: ScoringGroup, title: string, allText: string): number {
  const target = group.match === "title" ? title : allText;
  let best = 0;
  for (const tier of group.tiers) {
    if (!tier.keywords.some((k) => target.includes(k))) continue;
    let pts = tier.points;
    if (group.titleBoost !== 1 && tier.keywords.some((k) => title.includes(k))) {
      pts = Math.round(pts * group.titleBoost);
    }
    if (pts > best) best = pts;
  }
  return Math.min(best, group.weight);
}

function locationScore(loc: LocationScoring, allText: string): number {
  const excludedRe = makeMarkerRegex(loc.excluded);
  if (excludedRe && excludedRe.test(allText)) return 0;
  const preferredRe = makeMarkerRegex(loc.preferred);
  if (preferredRe && preferredRe.test(allText)) return loc.weight;
  return 0;
}

function compensationScore(
  config: ScoringConfig,
  job: { salary_min: number | null; salary_max: number | null }
): number {
  const bench = config.compensationBenchmark;
  if (bench === null) return 0;
  const w = config.compensationWeight;
  if (job.salary_max && job.salary_max >= bench) return w;
  if (job.salary_max && job.salary_max >= bench * 0.8) return Math.round(w / 2);
  if (!job.salary_min && !job.salary_max) return Math.round(w * 0.3); // unknown, don't penalize
  return 0;
}

export interface ScoreJobInput {
  title: string;
  company: string;
  description_text: string | null;
  location: string | null;
  tags: string[] | null;
  salary_min: number | null;
  salary_max: number | null;
  remote_type: string | null;
}

/** Score a single job against the parsed criteria. */
export function scoreJob(job: ScoreJobInput, config: ScoringConfig): ScoreBreakdown {
  const title = job.title.toLowerCase();
  const desc = (job.description_text || "").toLowerCase();
  const tags = (job.tags || []).map((t) => t.toLowerCase()).join(" ");
  const loc = (job.location || "").toLowerCase();
  const allText = `${title} ${desc} ${tags} ${loc}`;

  const breakdown: ScoreBreakdown = { total: 0 };

  // Hard filter: excluded titles zero the whole job (breakdown keys still
  // present, all zero, so triage can see why).
  const excluded = config.excludeTitles.some((k) => title.includes(k));
  if (excluded) {
    for (const g of config.groups) breakdown[g.name] = 0;
    if (config.location) breakdown.location = 0;
    if (config.compensationBenchmark !== null) breakdown.compensation = 0;
    breakdown.total = 0;
    return breakdown;
  }

  let total = 0;
  for (const g of config.groups) {
    const s = groupScore(g, title, allText);
    breakdown[g.name] = s;
    total += s;
  }

  if (config.location) {
    const s = locationScore(config.location, allText);
    breakdown.location = s;
    total += s;
  }

  if (config.compensationBenchmark !== null) {
    const s = compensationScore(config, job);
    breakdown.compensation = s;
    total += s;
  }

  breakdown.total = total;
  return breakdown;
}

// ---------------------------------------------------------------------------
// DB-facing helpers
// ---------------------------------------------------------------------------

interface ScoreRow {
  id: number;
  title: string;
  company: string;
  description_text: string | null;
  location: string | null;
  tags: string | null;
  salary_min: number | null;
  salary_max: number | null;
  remote_type: string | null;
}

function toScoreInput(row: ScoreRow): ScoreJobInput {
  return {
    title: row.title,
    company: row.company,
    description_text: row.description_text,
    location: row.location,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    remote_type: row.remote_type,
  };
}

/** Score all unscored jobs (scored_at IS NULL and not duplicate). */
export function scoreNewJobs(db: Database, config: ScoringConfig, verbose = false): number {
  const rows = db
    .query(
      `SELECT id, title, company, description_text, location, tags, salary_min, salary_max, remote_type
       FROM jobs WHERE scored_at IS NULL AND is_duplicate = 0`
    )
    .all() as ScoreRow[];

  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const updateStmt = db.prepare(
    "UPDATE jobs SET relevance_score = ?, score_breakdown = ?, scored_at = ? WHERE id = ?"
  );

  let scored = 0;
  for (const row of rows) {
    const breakdown = scoreJob(toScoreInput(row), config);
    updateStmt.run(breakdown.total, JSON.stringify(breakdown), now, row.id);
    scored++;

    if (verbose && breakdown.total >= config.queueThreshold) {
      console.log(`[score] #${row.id} "${row.title}" @ ${row.company} -> ${breakdown.total}`);
    }
  }

  return scored;
}

/**
 * Re-score ALL jobs (not just unscored). Updates scores but preserves manual
 * review statuses; only pending/queued jobs are later reclassified.
 */
export function rescoreAllJobs(db: Database, config: ScoringConfig, verbose = false): number {
  const rows = db
    .query(
      `SELECT id, title, company, description_text, location, tags, salary_min, salary_max, remote_type, relevance_score
       FROM jobs WHERE is_duplicate = 0`
    )
    .all() as Array<ScoreRow & { relevance_score: number }>;

  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const updateStmt = db.prepare(
    "UPDATE jobs SET relevance_score = ?, score_breakdown = ?, scored_at = ? WHERE id = ?"
  );

  let rescored = 0;
  let changed = 0;
  for (const row of rows) {
    const breakdown = scoreJob(toScoreInput(row), config);
    if (row.relevance_score !== breakdown.total) changed++;
    updateStmt.run(breakdown.total, JSON.stringify(breakdown), now, row.id);
    rescored++;
  }

  if (verbose) {
    console.log(`[rescore] ${rescored} jobs rescored, ${changed} scores changed`);
  }

  return rescored;
}

/** Auto-classify jobs by the criteria's score thresholds. */
export function autoClassify(db: Database, config: ScoringConfig): void {
  db.query(
    `UPDATE jobs SET review_status = 'queued'
     WHERE relevance_score >= ?
     AND review_status = 'pending'
     AND is_duplicate = 0
     AND reviewed_at IS NULL`
  ).run(config.queueThreshold);

  db.query(
    `UPDATE jobs SET review_status = 'dismissed'
     WHERE relevance_score < ?
     AND review_status = 'pending'
     AND is_duplicate = 0
     AND reviewed_at IS NULL`
  ).run(config.dismissThreshold);
}
