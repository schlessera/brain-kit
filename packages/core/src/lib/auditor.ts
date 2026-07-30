import { Database } from "bun:sqlite";
import { Glob } from "bun";

import type { AuditIssue } from "./types.js";
import type { Taxonomy } from "./taxonomy.js";

/** Milliseconds per day. */
const MS_PER_DAY = 86_400_000;

export interface AuditOptions {
  /** Wall clock to measure ages against — injected for deterministic tests. */
  now?: Date;
}

/**
 * Run all audit checks against the indexed database.
 *
 * Taxonomy supplies every path-shaped policy: staleness thresholds
 * (stalenessFor), the source→derivative propagation rules (propagation),
 * orphan exemptions (isOrphanExempt), the expected directory prefixes per type
 * (expectedPrefixesFor), and the directory-anchor names (dirAnchors). Nothing
 * about the document taxonomy is hardcoded here.
 */
export function audit(
  db: Database,
  taxonomy: Taxonomy,
  opts: AuditOptions = {}
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const now = (opts.now ?? new Date()).getTime();

  // Load all markdown documents. Binary assets (pdf/jpg/png) can't carry
  // wiki-links or frontmatter, so auditing them only produces noise
  // (orphan and type-mismatch findings for every asset).
  const docs = db
    .prepare(
      `SELECT id, path, title, type, status, relevance, updated, content
       FROM documents
       WHERE asset_type = 'markdown'
       ORDER BY path`
    )
    .all() as {
    id: number;
    path: string;
    title: string;
    type: string;
    status: string;
    relevance: string;
    updated: string;
    content: string;
  }[];

  // ---------------------------------------------------------------
  // 1. Staleness checks
  // ---------------------------------------------------------------
  for (const doc of docs) {
    if (doc.status === "archived") continue;

    const updatedMs = new Date(doc.updated).getTime();
    const ageDays = Math.floor((now - updatedMs) / MS_PER_DAY);

    // Threshold + severity come from the taxonomy (longest matching prefix
    // rule, else the configured default).
    const { days: threshold, severity } = taxonomy.stalenessFor(doc.path);

    if (ageDays > threshold) {
      issues.push({
        path: doc.path,
        severity,
        category: "staleness",
        message: `Last updated ${ageDays} days ago (threshold: ${threshold} days)`,
        suggestion: `Review and update ${doc.path}`,
      });
    }
  }

  // ---------------------------------------------------------------
  // 2. Propagation checks — a derivative must not lag behind its source
  // ---------------------------------------------------------------
  // Each taxonomy propagation rule names a canonical source document and a glob
  // for the derivatives generated from it (e.g. bios generated from a canonical
  // FACTS.md must not lag behind it).
  for (const rule of taxonomy.propagation) {
    const source = docs.find((d) => d.path === rule.source);
    if (!source) continue;
    const sourceUpdated = new Date(source.updated).getTime();
    const severity = rule.severity ?? "warning";
    const glob = new Glob(rule.derivatives);

    for (const doc of docs) {
      if (doc.path === rule.source || !glob.match(doc.path)) continue;
      const docUpdated = new Date(doc.updated).getTime();
      if (sourceUpdated > docUpdated) {
        issues.push({
          path: doc.path,
          severity,
          category: "propagation",
          message: `${rule.source} was updated more recently than this derivative (source: ${source.updated}, this: ${doc.updated})`,
          suggestion: `Regenerate ${doc.path} from ${rule.source}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 2b. Index lag check — _index.md files older than their detail files
  // ---------------------------------------------------------------
  // Mechanical enforcement of the Index Sync Principle: an _index.md is a
  // summary layer over its directory subtree and must not lag behind it.
  const indexDocs = docs.filter((d) => d.path.endsWith("_index.md"));
  for (const indexDoc of indexDocs) {
    const dirPrefix = indexDoc.path.slice(0, -"_index.md".length);
    const indexUpdated = new Date(indexDoc.updated).getTime();

    let newestDetail: { path: string; updated: string } | null = null;
    for (const doc of docs) {
      if (doc.path === indexDoc.path || !doc.path.startsWith(dirPrefix)) continue;
      // Nested _index.md files own their subtree — don't blame the parent
      if (doc.path.endsWith("_index.md")) continue;
      if (doc.status === "archived") continue;
      if (!newestDetail || doc.updated > newestDetail.updated) {
        newestDetail = { path: doc.path, updated: doc.updated };
      }
    }

    if (newestDetail) {
      const detailUpdated = new Date(newestDetail.updated).getTime();
      const lagDays = Math.floor((detailUpdated - indexUpdated) / MS_PER_DAY);
      if (lagDays > 7) {
        issues.push({
          path: indexDoc.path,
          severity: "warning",
          category: "index-lag",
          message: `Index lags ${lagDays} days behind ${newestDetail.path} (index: ${indexDoc.updated}, detail: ${newestDetail.updated})`,
          suggestion: `Review ${indexDoc.path} and sync it with its detail files`,
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 2c. Stale drafts — draft status is a working state, not a parking lot
  // ---------------------------------------------------------------
  const DRAFT_MAX_AGE_DAYS = 90;
  for (const doc of docs) {
    if (doc.status !== "draft") continue;
    const ageDays = Math.floor((now - new Date(doc.updated).getTime()) / MS_PER_DAY);
    if (ageDays > DRAFT_MAX_AGE_DAYS) {
      issues.push({
        path: doc.path,
        severity: "info",
        category: "stale-draft",
        message: `Draft for ${ageDays} days (threshold: ${DRAFT_MAX_AGE_DAYS})`,
        suggestion: "Finish it, set status: active, or archive it",
      });
    }
  }

  // ---------------------------------------------------------------
  // 2d. Tag vocabulary noise — one aggregate issue, not one per tag
  // ---------------------------------------------------------------
  try {
    const tagRows = db
      .prepare(
        `SELECT t.name, COUNT(dt.document_id) AS n
         FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
         GROUP BY t.id`
      )
      .all() as { name: string; n: number }[];
    const singletons = tagRows.filter((r) => r.n === 1);
    if (tagRows.length > 0 && singletons.length / tagRows.length > 0.4) {
      const sample = singletons.slice(0, 8).map((r) => r.name).join(", ");
      issues.push({
        path: "(corpus)",
        severity: "info",
        category: "tag-noise",
        message: `${singletons.length} of ${tagRows.length} tags are used by exactly one document (e.g. ${sample})`,
        suggestion: "Singleton tags filter nothing — merge into broader tags or drop during routine edits",
      });
    }
  } catch {
    // tags tables may be empty
  }

  // ---------------------------------------------------------------
  // 3. TODO / VERIFY marker detection
  // ---------------------------------------------------------------
  const todoRegex = /\[TODO:[^\]]*\]/g;
  const verifyRegex = /\[VERIFY:[^\]]*\]/g;

  for (const doc of docs) {
    const todoMatches = doc.content.match(todoRegex);
    if (todoMatches) {
      for (const match of todoMatches) {
        issues.push({
          path: doc.path,
          severity: "info",
          category: "todo",
          message: `Contains marker: ${match}`,
        });
      }
    }

    const verifyMatches = doc.content.match(verifyRegex);
    if (verifyMatches) {
      for (const match of verifyMatches) {
        issues.push({
          path: doc.path,
          severity: "warning",
          category: "verify",
          message: `Contains unverified content: ${match}`,
          suggestion: "Verify this information and remove the marker",
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 4. Type / directory mismatch
  // ---------------------------------------------------------------
  for (const doc of docs) {
    const expectedDirs = taxonomy.expectedPrefixesFor(doc.type);
    if (!expectedDirs) continue; // dir: null (e.g. index) or unknown — skip

    const matchesExpected = expectedDirs.some((dir) => doc.path.startsWith(dir));
    if (!matchesExpected) {
      issues.push({
        path: doc.path,
        severity: "warning",
        category: "type-mismatch",
        message: `Document type "${doc.type}" expected in ${expectedDirs.join(" or ")}, found at ${doc.path}`,
        suggestion: `Move to ${expectedDirs[0]} or change type`,
      });
    }
  }

  // ---------------------------------------------------------------
  // 5. Orphan detection
  // ---------------------------------------------------------------
  // Exclude orphan-exempt types (index/context and any config-declared
  // exemptions) and _index.md files.
  const candidateDocs = docs.filter(
    (d) => !taxonomy.isOrphanExempt(d.type) && !d.path.endsWith("_index.md")
  );

  // Pre-compute plain-markdown incoming links so detail files referenced
  // via `[text](slug/)` from _index.md files are not flagged as orphans.
  const allPaths = new Set(docs.map((d) => d.path));
  const plainIncoming = new Set<string>();
  const linkRegex = /\]\(([^)]+)\)/g;

  for (const src of docs) {
    const srcDir = src.path.includes("/")
      ? src.path.slice(0, src.path.lastIndexOf("/"))
      : "";
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(src.content)) !== null) {
      let target = match[1].split("#")[0].split("?")[0].trim();
      if (
        !target ||
        target.startsWith("http") ||
        target.startsWith("mailto:") ||
        target.startsWith("[")
      )
        continue;

      const candidates: string[] = [];
      const join = (a: string, b: string) =>
        (a ? `${a}/${b}` : b).replace(/\/\.\//g, "/").replace(/^\.\//, "");

      if (target.endsWith("/")) {
        // A directory link resolves to one of the directory's anchor files —
        // taxonomy.dirAnchors names them (e.g. _index.md, status.md).
        const stripped = target.replace(/\/$/, "");
        for (const anchor of taxonomy.dirAnchors) {
          candidates.push(join(srcDir, `${stripped}/${anchor}`));
        }
      } else if (target.endsWith(".md")) {
        candidates.push(join(srcDir, target));
        candidates.push(target);
      }

      for (const c of candidates) {
        if (allPaths.has(c)) plainIncoming.add(c);
      }
    }
  }

  for (const doc of candidateDocs) {
    // Check for outgoing links
    const outgoing = db
      .prepare("SELECT COUNT(*) as count FROM links WHERE source_id = ?")
      .get(doc.id) as { count: number };

    // Check for incoming links
    const incoming = db
      .prepare("SELECT COUNT(*) as count FROM links WHERE target_id = ?")
      .get(doc.id) as { count: number };

    const hasPlainIncoming = plainIncoming.has(doc.path);

    if (outgoing.count === 0 && incoming.count === 0 && !hasPlainIncoming) {
      issues.push({
        path: doc.path,
        severity: "info",
        category: "orphan",
        message: "Document has no incoming or outgoing wiki-links",
        suggestion: "Add [[wiki-links]] to connect this document to others",
      });
    }
  }

  return issues;
}
