// Private #841 controls. This delegates to an existing writer, never ships a repair API.
import { readFileSync } from "node:fs";
import { getMarkdownFiles } from "../../../packages/core/src/lib/indexer";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { isAbsolute } from "node:path";
import { safeResolve } from "../../../packages/core/src/lib/safe-path";
import { planRegistry, applyRegistry } from "../../../packages/core/src/lib/index-registry";
import { validate } from "../../../packages/core/src/lib/validate";
import { candidateFromAudit, hygieneId } from "../../../packages/core/src/lib/hygiene";
import type { AuditDoc } from "../../../packages/core/src/lib/auditor";
import type { AuditIssue } from "../../../packages/core/src/lib/types";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";

export function capability(root: string, taxonomy: Taxonomy, finding: AuditIssue, asOf: string, docs = new Map<string, AuditDoc>()) {
  const candidate = candidateFromAudit(finding, docs);
  const base = {
    id: hygieneId(candidate.category, candidate.path, candidate.evidence), evidence: candidate.evidence,
    suggestion: finding.suggestion || "Manual review needed.", handlerAvailable: false,
    executionAuthorized: false, handler: null as "registry" | null,
  };
  const manual = (reason: string) => ({ ...base, reason, plan: null });
  if (isAbsolute(finding.path) || finding.path.includes("\\") || finding.path.split("/").some(p => !p || p.startsWith(".")) || !safeResolve(root, finding.path)) return manual("unsafe or aggregate path");
  // Category is a code capability gate, not a natural-language instruction.
  if (finding.category !== "index-stale") return manual("no bounded handler for this finding");
  try {
    const plan = planRegistry(root, taxonomy, asOf);
    const index = plan.indexes.find(i => i.path === finding.path);
    if (!index) return manual("registry absent or invalid");
    if (index.next === null) return manual("no content change required");
    const prefix = finding.path.slice(0, -"_index.md".length);
    // #854 tracks the production membership bug. Keep this private control conservative.
    for (const path of getMarkdownFiles(root, taxonomy).filter(p => p.startsWith(prefix))) {
      const full = safeResolve(root, path);
      if (!full) return manual("unsafe source path");
      const type = parseFrontmatter(readFileSync(full, "utf8")).data.type;
      if (typeof type !== "string" || !Object.hasOwn(taxonomy.types, type)) return manual("unconfigured source type");
    }
    if (validate(root, taxonomy).some(i => i.level === "error" && i.file.startsWith(prefix))) return manual("invalid source metadata");
    return { ...base, handlerAvailable: true, handler: "registry" as const, reason: "valid opted-in registry plan", plan: { indexes: [index], problems: [] } };
  } catch { return manual("source read failed"); }
}

/** Execute only in disposable fixtures with separately supplied authorization. */
export function applyFixtureCandidate(root: string, taxonomy: Taxonomy, finding: AuditIssue, asOf: string, authorized: boolean) {
  if (!authorized) return { written: [] as string[], reason: "not authorized" };
  const inspected = capability(root, taxonomy, finding, asOf);
  if (!inspected.handlerAvailable || !inspected.plan) return { written: [] as string[], reason: inspected.reason };
  const run = applyRegistry(root, inspected.plan, {});
  return { written: run.written, reason: run.stale.length ? "changed during apply" : "existing handler completed" };
}
