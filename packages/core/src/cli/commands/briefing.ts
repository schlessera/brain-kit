import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "../../lib/context.js";
import {
  findBudgetOverruns,
  findOverdueReviews,
  findPastDates,
  findStale,
  isoDay,
  loadAuditDocs,
  type AuditDoc,
} from "../../lib/auditor.js";
import type { Taxonomy } from "../../lib/taxonomy.js";
import { openDatabase } from "../../lib/db.js";
import { filterSearch } from "../../lib/search-engine.js";
import type { CoreCommand } from "../types.js";
import { parseArgs } from "../io.js";

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

/** Milliseconds per day. */
const MS_PER_DAY = 86_400_000;

/**
 * `value` as an inline code span on one line, so a path or a frontmatter
 * value can neither open markdown or HTML nor break the warning across
 * lines. The fence is one backtick longer than any run inside.
 */
function literal(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/**
 * One warning line per `brain audit` finding about the focus document: an
 * overdue review, a blown token budget, past-dated lines. They come from the
 * audit's own checks, so the briefing and `brain audit` cannot disagree.
 * Every interpolated value is rendered through `literal`.
 */
function focusWarnings(docs: AuditDoc[], taxonomy: Taxonomy, focusRel: string, now: number): string[] {
  const focus = docs.find((d) => d.path === focusRel);
  if (!focus) return [];
  const warnings: string[] = [];
  const todayStr = isoDay(now);
  const path = literal(focusRel);

  for (const { due } of findOverdueReviews(docs, taxonomy, now).filter((r) => r.doc.path === focusRel)) {
    if (isDay(due)) {
      const days = Math.round((Date.parse(todayStr) - Date.parse(due)) / MS_PER_DAY);
      warnings.push(`> **Warning:** ${path} is ${days} day(s) overdue for review (due ${due}); the priorities below may be stale.`);
    } else {
      warnings.push(`> **Warning:** ${path} is overdue for review (its due date ${literal(due)} is not a YYYY-MM-DD day); the priorities below may be stale.`);
    }
  }
  for (const { tokens, maxTokens } of findBudgetOverruns(docs, taxonomy).filter((o) => o.doc.path === focusRel)) {
    warnings.push(`> **Warning:** ${path} is ~${tokens} tokens, over its ${maxTokens}-token budget.`);
  }
  if (focus.status !== "archived" && taxonomy.canonicalPolicy.currentFocus) {
    const past = findPastDates(focus.content, todayStr).length;
    if (past > 0) {
      warnings.push(`> **Warning:** ${path} has ${past} line(s) naming a past date; \`brain audit\` lists them.`);
    }
  }
  return warnings;
}

/**
 * Assemble the structured briefing data. Mechanical (no LLM): warnings about
 * the focus document, current focus, focus-linked documents, upcoming
 * deadlines, overdue reviews, recently active primary docs, silently-modified
 * files, and stale documents.
 *
 * Ported from the reference brain's generateBriefing (brain-cli.ts:328-433).
 * The one genericization: the current-focus document and its link graph are
 * keyed off `taxonomy.canonicalPath("currentFocus")` instead of the literal
 * "context/current-focus.md", and both sections are skipped when that canonical
 * path is unset — essential for a fresh template with no current-focus file.
 * Throws when the index is missing so importers can handle it themselves.
 */
export function generateBriefing(brain: BrainContext, limit = 15): string {
  if (!existsSync(brain.dbPath)) {
    throw new Error("Database not found. Run `brain index` first.");
  }
  const db = openDatabase(brain.dbPath, { readonly: true });
  const lines: string[] = [];
  const now = new Date();
  const todayStr = isoDay(now.getTime());
  // One identity for the focus document: the indexed spelling, and only while
  // the file is there. Warnings, the section and its links all follow it.
  const canonicalFocus = brain.taxonomy.canonicalPath("currentFocus");
  const focusRel = canonicalFocus && existsSync(resolve(brain.root, canonicalFocus)) ? canonicalFocus : null;

  try {
    const docs = loadAuditDocs(db);

    // 0. Warnings about the focus document, ahead of it, so stale priorities
    // are not read as current.
    if (focusRel) {
      const warnings = focusWarnings(docs, brain.taxonomy, focusRel, now.getTime());
      if (warnings.length > 0) lines.push(...warnings, "");
    }

    // 1. Current focus (verbatim, without frontmatter)
    if (focusRel) {
      const { content } = matter(readFileSync(resolve(brain.root, focusRel), "utf-8"));
      lines.push("## Current Focus\n");
      lines.push(content.trim());
    }

    // 2. Focus-linked documents (wiki-links from the current-focus doc)
    if (focusRel) {
      const focusLinks = db
        .prepare(
          `SELECT d.path, d.title, d.type, d.updated, d.summary
           FROM links l
           JOIN documents d ON d.id = l.target_id
           WHERE l.source_id = (SELECT id FROM documents WHERE path = ?)
           ORDER BY d.updated DESC`
        )
        .all(focusRel) as any[];
      if (focusLinks.length > 0) {
        lines.push("\n## Focus-Linked Documents\n");
        for (const r of focusLinks) {
          lines.push(`- ${r.updated} | ${r.type} | ${r.path} | ${r.title} | ${r.summary || ""}`);
        }
      }
    }

    // 3. Upcoming deadlines (next 60 days)
    const futureDate = addDays(todayStr, 60);
    const deadlines = db
      .prepare(
        `SELECT deadline, path, title, summary FROM documents
         WHERE deadline >= ? AND deadline <= ? AND status != 'archived'
         ORDER BY deadline ASC`
      )
      .all(todayStr, futureDate) as any[];
    if (deadlines.length > 0) {
      lines.push("\n## Upcoming Deadlines\n");
      for (const r of deadlines) {
        lines.push(`- ${r.deadline} | ${r.path} | ${r.title} | ${r.summary || ""}`);
      }
    }

    // 4. Overdue reviews
    const overdue = db
      .prepare(
        `SELECT next_review, path, title FROM documents
         WHERE next_review IS NOT NULL AND next_review <= ? AND status != 'archived'
         ORDER BY next_review ASC`
      )
      .all(todayStr) as any[];
    if (overdue.length > 0) {
      lines.push("\n## Overdue Reviews\n");
      for (const r of overdue) {
        lines.push(`- ${r.next_review} | ${r.path} | ${r.title}`);
      }
    }

    // 5. Recently active primary docs
    const recent = filterSearch(db, { relevance: "primary", limit });
    if (recent.length > 0) {
      lines.push("\n## Recently Active\n");
      for (const r of recent) {
        const row = db.prepare("SELECT updated FROM documents WHERE path = ?").get(r.path) as any;
        lines.push(`- ${row?.updated || "?"} | ${r.type} | ${r.path} | ${r.title} | ${(r.summary || "").slice(0, 80)}`);
      }
    }

    // 6. Silently modified (file changed but frontmatter `updated` not bumped).
    // Mtimes baselined via `brain accept-mtime` are exempt.
    const silentMods = db
      .prepare(
        `SELECT file_mtime, updated, path, title FROM documents
         WHERE file_mtime > updated
           AND (accepted_mtime IS NULL OR file_mtime > accepted_mtime)
           AND status != 'archived'
         ORDER BY file_mtime DESC LIMIT 10`
      )
      .all() as any[];
    if (silentMods.length > 0) {
      lines.push("\n## Silently Modified\n");
      for (const r of silentMods) {
        lines.push(`- file: ${r.file_mtime} | frontmatter: ${r.updated} | ${r.path} | ${r.title}`);
      }
    }

    // 7. Stale documents, by the taxonomy's thresholds: findStale is the
    // definition `brain audit` and `brain stats` share. Most overdue first.
    const stale = findStale(docs, brain.taxonomy, now.getTime()).sort(
      (a, b) => b.ageDays - b.threshold - (a.ageDays - a.threshold) || b.ageDays - a.ageDays
    );
    if (stale.length > 0) {
      lines.push("\n## Stale Documents\n");
      for (const { doc, ageDays } of stale) {
        lines.push(`- ${doc.updated} (${ageDays}d ago) | ${doc.path} | ${doc.title}`);
      }
    }
  } finally {
    db.close();
  }

  return lines.join("\n");
}

export const briefingCommand: CoreCommand = {
  summary: "Emit a mechanical daily briefing (deadlines, reviews, silent edits)",
  helpBlock: `brain briefing — mechanical daily status (no LLM)

  --limit <n>             Max recently-active docs (default: 15)`,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const limit = parseInt(flags.limit as string, 10) || 15;
    // Briefing is plain text (contract). Errors surface as usage failures.
    console.log(generateBriefing(cli.brain, limit));
  },
};
