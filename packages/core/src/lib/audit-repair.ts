import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { getMarkdownFiles } from "./indexer.js";
import { planRegistry } from "./index-registry.js";
import { safeResolve } from "./safe-path.js";
import type { Taxonomy } from "./taxonomy.js";
import type { AuditIssue } from "./types.js";
import { validate } from "./validate.js";

/** One suggestion per finding; availability never grants execution permission. */
export interface AuditFixResult {
  path: string;
  issue: string;
  suggestion: string;
  canAutoFix: boolean;
  /** Exact replacement text, if supplied; audit --fix never emits this field. */
  fix?: string;
  repair?: { capability: "registry"; path: string };
}

/**
 * One suggester per audit run. The registry plan and validation are computed at most
 * once, on the first `index-stale` finding, and shared by every later finding.
 */
export function auditFixSuggester(root: string, taxonomy: Taxonomy, asOf: string): (finding: AuditIssue) => AuditFixResult {
  let plan: ReturnType<typeof planRegistry> | undefined;
  let issues: ReturnType<typeof validate> | undefined;
  const context = {
    plan: () => (plan ??= planRegistry(root, taxonomy, asOf)),
    validation: () => (issues ??= validate(root, taxonomy)),
  };
  return (finding) => suggestAuditFix(root, taxonomy, finding, asOf, context);
}

/** Inspect the existing registry capability without applying or authorizing it. */
export function suggestAuditFix(root: string, taxonomy: Taxonomy, finding: AuditIssue, asOf: string,
  context = { plan: () => planRegistry(root, taxonomy, asOf), validation: () => validate(root, taxonomy) }): AuditFixResult {
  const base: AuditFixResult = {
    path: finding.path,
    issue: finding.message,
    suggestion: finding.suggestion || "Manual review needed.",
    canAutoFix: false,
  };
  const manual = (reason: string): AuditFixResult => ({
    ...base,
    suggestion: finding.category !== "index-stale" ? base.suggestion : reason === "no content change required"
      ? "No registry content change is required; leave files unchanged."
      : `Read the index, its children, and the taxonomy; resolve ${reason} before considering registry regeneration.`,
  });
  if (isAbsolute(finding.path) || finding.path.includes("\\") || finding.path.split("/").some(p => !p || p.startsWith(".")) || !safeResolve(root, finding.path)) {
    return manual("unsafe or aggregate path");
  }
  if (finding.category !== "index-stale") return manual("no bounded handler for this finding");
  try {
    const index = context.plan().indexes.find(i => i.path === finding.path);
    if (!index) return manual("registry absent or invalid");
    if (index.next === null) return manual("no content change required");
    const prefix = finding.path.slice(0, -"_index.md".length);
    // Membership alone does not establish valid metadata for every child.
    for (const path of getMarkdownFiles(root, taxonomy).filter(p => p.startsWith(prefix))) {
      const full = safeResolve(root, path);
      if (!full) return manual("unsafe source path");
      const type = parseFrontmatter(readFileSync(full, "utf8")).data.type;
      if (typeof type !== "string" || !Object.hasOwn(taxonomy.types, type)) return manual("unconfigured source type");
    }
    if (context.validation().some(i => i.level === "error" && i.file.startsWith(prefix))) return manual("invalid source metadata");
    return { ...base, canAutoFix: true, repair: { capability: "registry", path: index.path } };
  } catch {
    return manual("source read failed");
  }
}
