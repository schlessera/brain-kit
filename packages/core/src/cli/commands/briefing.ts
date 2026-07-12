import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";

import type { BrainContext } from "../../lib/context";
import { openDatabase } from "../../lib/db";
import { filterSearch } from "../../lib/search-engine";
import type { CoreCommand } from "../types";
import { parseArgs, today } from "../io";

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/**
 * Assemble the structured briefing data. Mechanical (no LLM): current focus,
 * focus-linked documents, upcoming deadlines, overdue reviews, recently active
 * primary docs, silently-modified files, and stale context.
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
  const todayStr = today();
  const focusRel = brain.taxonomy.canonicalPath("currentFocus");

  try {
    // 1. Current focus (verbatim, without frontmatter)
    if (focusRel) {
      const focusPath = resolve(brain.root, focusRel);
      if (existsSync(focusPath)) {
        const { content } = matter(readFileSync(focusPath, "utf-8"));
        lines.push("## Current Focus\n");
        lines.push(content.trim());
      }
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

    // 7. Stale context files (>30 days since frontmatter update)
    const staleDate = addDays(todayStr, -30);
    const stale = db
      .prepare(
        `SELECT updated, path, title FROM documents
         WHERE type = 'context' AND updated < ? AND status != 'archived'
         ORDER BY updated ASC`
      )
      .all(staleDate) as any[];
    if (stale.length > 0) {
      lines.push("\n## Stale Context\n");
      for (const r of stale) {
        const daysAgo = daysBetween(r.updated, todayStr);
        lines.push(`- ${r.updated} (${daysAgo}d ago) | ${r.path} | ${r.title}`);
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
