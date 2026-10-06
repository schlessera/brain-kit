/**
 * The job pipeline, as frontmatter.
 *
 * An opportunity's `status.md` records where it stands in fields, not prose:
 *
 *     stage: researching | applied | screening | interviewing | offer | closed
 *     fit: strong | medium | weak
 *     applied: 2026-06-01          # the day the application went out
 *     next_step: "Technical interview with the team lead"
 *     deadline: 2026-06-12         # core's field: the next step's date
 *     closed_reason: "Declined after the offer"
 *
 * The pipeline `_index.md` in the opportunities directory is then a view of
 * those fields: `brain jobs pipeline` gives it the registry spec below, and
 * `brain registry` (and bare `brain maintain`) keep its table current.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "./lib/frontmatter-parse.js";
import { type AuditIssue, type HygieneContext } from "@schlessera/brain";
import { safeResolve, splitFrontmatterBlock, writeFileSafely } from "@schlessera/brain/internal";

import type { JobsConfig } from "./module.js";

export const STAGES = ["researching", "applied", "screening", "interviewing", "offer", "closed"] as const;
export type Stage = (typeof STAGES)[number];

/** Stages still in play; everything but `closed`. */
export const ACTIVE_STAGES: readonly Stage[] = STAGES.filter((s) => s !== "closed");

/** A `researching` opportunity untouched this long is flagged: close or advance it. */
export const RESEARCHING_STALE_DAYS = 60;

/**
 * The `registry:` block the pipeline index gets: the opportunities' status
 * files (the only children with a `stage`), one table for the active stages
 * and one for closed, newest first. Written as YAML text so the index's other
 * frontmatter keeps its layout.
 */
export const PIPELINE_REGISTRY_YAML = [
  "registry:",
  "  columns: [link, stage, fit, next_step, deadline, updated]",
  `  where: { stage: [${STAGES.join(", ")}] }`,
  "  sort: -updated",
  `  split: { key: stage, tables: { Active: [${ACTIVE_STAGES.join(", ")}], Closed: [closed] } }`,
].join("\n");

/**
 * Make sure the pipeline index exists and carries a registry spec. A missing
 * index is created (never over a file that appears meanwhile); one without a
 * `registry:` block gets the module's, added at the end of its frontmatter
 * with every other byte left as it was; one that already has a block keeps
 * it. The result is parsed back before it is written: it must hold exactly
 * the module's spec and every other key as it was, so a layout the append
 * cannot extend (a flow mapping, a `...` document end) is refused with the
 * file untouched. So is a file whose frontmatter never closes, one that
 * changes between the read and the write, and a path that leaves the brain
 * root, which is checked before any directory is created. Returns what it did.
 */
export function ensurePipelineIndex(
  root: string,
  opportunitiesDir: string,
  today: string
): { path: string; action: "created" | "added" | "kept" } {
  const path = join(opportunitiesDir, "_index.md");
  // Canonical, and inside the root, before anything is created: a symlinked
  // parent must not get a directory made outside the brain.
  const full = safeResolve(root, path);
  if (full === null) throw new Error(`${path} leaves the brain root; refusing to create or change it`);
  if (!existsSync(full)) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSafely(
      full,
      [
        "---",
        "type: index",
        'title: "Opportunity Pipeline"',
        `created: ${today}`,
        `updated: ${today}`,
        "tags: [job-search]",
        "status: active",
        "relevance: primary",
        'summary: "Every tracked opportunity, by stage"',
        PIPELINE_REGISTRY_YAML,
        "---",
        "",
        "Every opportunity's `status.md`, by `stage`. The tables below are generated from their",
        "frontmatter by `brain registry`; edit the opportunities, not the tables.",
        "",
      ].join("\n"),
      { replace: false }
    );
    return { path, action: "created" };
  }
  const raw = readFileSync(full, "utf8");
  let frontmatter: string;
  try {
    ({ frontmatter } = splitFrontmatterBlock(raw));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}; fix it by hand before adding the registry spec`);
  }
  if (!frontmatter) throw new Error(`${path} has no frontmatter block to add a registry spec to`);
  if (parseFrontmatter(raw).data.registry !== undefined) return { path, action: "kept" };
  // The block ends in its closing `---`; the spec goes on the lines before it.
  const beforeClose = frontmatter.slice(0, -3);
  const eol = beforeClose.endsWith("\r\n") ? "\r\n" : "\n";
  const next = `${beforeClose}${PIPELINE_REGISTRY_YAML.replace(/\n/g, eol)}${eol}${raw.slice(beforeClose.length)}`;
  if (!readsBackWithSpec(raw, next)) {
    throw new Error(
      `${path}: its frontmatter layout cannot take the registry spec as appended lines (a flow mapping or a \`...\` end, for example); ` +
        "add the `registry:` block by hand, or rewrite the frontmatter as a block mapping"
    );
  }
  // An edit since the read (an editor saving the index) is not overwritten.
  if (readFileSync(full, "utf8") !== raw) throw new Error(`${path} changed while the registry spec was being added; run it again`);
  writeFileSafely(full, next);
  return { path, action: "added" };
}

/** The registry spec as the pipeline index should read it back. */
const PIPELINE_SPEC = parseFrontmatter(`---\n${PIPELINE_REGISTRY_YAML}\n---\n`).data.registry as unknown;

/**
 * Whether `next` parses to `raw`'s frontmatter plus exactly the pipeline
 * spec, every other key unchanged (compared as JSON, so a date stays a date).
 */
function readsBackWithSpec(raw: string, next: string): boolean {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    splitFrontmatterBlock(next);
    before = parseFrontmatter(raw).data;
    after = parseFrontmatter(next).data;
  } catch {
    return false;
  }
  if (JSON.stringify(after.registry) !== JSON.stringify(PIPELINE_SPEC)) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("registry");
  for (const key of keys) if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) return false;
  return true;
}

const MS_PER_DAY = 86_400_000;

/**
 * Hygiene: an opportunity `status.md` with no `stage` (info), and one still
 * `researching` whose `updated` is older than RESEARCHING_STALE_DAYS (info:
 * close or advance it). Archived opportunities are left alone.
 */
export function checkOpportunityStages(ctx: HygieneContext<JobsConfig>, now = new Date()): AuditIssue[] {
  // The complete path-ordered candidate set; null status is excluded with archived.
  const found = ctx.queries.findIndexDocuments({ type: "opportunity", excludeStatus: "archived" });
  if (!found.ok) throw new Error(indexFailure(found.error.code));
  const rows = found.value.filter((row) => isStatusFile(row.path));
  const issues: AuditIssue[] = [];
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(readFileSync(join(ctx.root, row.path), "utf8")).data;
    } catch {
      continue; // unreadable or invalid frontmatter: `brain validate` reports it
    }
    const stage = data.stage;
    if (stage === undefined || stage === null || stage === "") {
      issues.push({
        path: row.path,
        severity: "info",
        category: "jobs-stage",
        message: "Opportunity has no `stage`",
        suggestion: `Set stage: one of ${STAGES.join(", ")}`,
      });
      continue;
    }
    if (stage === "researching") {
      // A null `updated` parses to NaN and is never stale, as with the former SQL row.
      const days = Math.floor((now.getTime() - Date.parse(row.updated ?? "")) / MS_PER_DAY);
      if (days > RESEARCHING_STALE_DAYS) {
        issues.push({
          path: row.path,
          severity: "info",
          category: "jobs-stage",
          message: `Still researching, last updated ${days} days ago (over ${RESEARCHING_STALE_DAYS})`,
          suggestion: "Close or advance it: set stage (and closed_reason when closing)",
        });
      }
    }
  }
  return issues;
}

/**
 * The former SQL predicate, `path = 'status.md' OR path LIKE '%/status.md'`:
 * the root file matches exactly, a nested one with SQLite LIKE's ASCII-only
 * case folding. So root `STATUS.MD` is out, nested `STATUS.MD` is in, and
 * `notstatus.md` is out at any depth. A literal suffix query cannot express
 * this, so the module filters the complete candidate set itself.
 */
function isStatusFile(path: string): boolean {
  if (path === "status.md") return true;
  return path.replace(/[A-Z]/g, (c) => c.toLowerCase()).endsWith("/status.md");
}

/** A failed index read fails the check: it is never an empty, clean result. */
function indexFailure(code: string): string {
  const action =
    code === "missing_index" ? "run `brain index`"
    : code === "incompatible_index" || code === "corrupt_index" ? "run `brain index --force`"
    : code === "busy_index" ? "retry"
    : "check the index";
  return `opportunity stages could not read the content index (${code}): ${action}`;
}
