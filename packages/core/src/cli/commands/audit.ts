import type { AuditIssue } from "../../lib/types.js";
import { audit } from "../../lib/auditor.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs } from "../io.js";

const HELP = `brain audit — staleness and quality audit

  --fix                   Ask a completion provider for fix suggestions (degrades
                          to plain issues when no API key is configured)

--json envelope: { "issues": AuditIssue[], "errors", "warnings", "infos" }
(markdown documents only — assets excluded).`;

interface AuditFixResult {
  path: string;
  issue: string;
  suggestion: string;
  canAutoFix: boolean;
  fix?: string;
}

/** Best-effort fix suggestions via a plain completion (Tier-2). */
async function suggestFixes(issues: AuditIssue[], cli: Parameters<CoreCommand["run"]>[1]): Promise<AuditFixResult[]> {
  const manual = (): AuditFixResult[] =>
    issues.map((i) => ({
      path: i.path,
      issue: i.message,
      suggestion: i.suggestion || "Manual review needed.",
      canAutoFix: false,
    }));

  if (!cli.completions) return manual();

  const issueList = issues
    .map((i, n) => `${n + 1}. [${i.severity}] ${i.path}: ${i.message}${i.suggestion ? ` (suggestion: ${i.suggestion})` : ""}`)
    .join("\n");

  const prompt = `Here are audit issues found in a file-first knowledge base. For each, suggest a fix.

Issues:
${issueList}

Respond with a JSON array of objects:
[{ "path": "<file>", "issue": "<brief>", "suggestion": "<what to do>", "canAutoFix": <bool>, "fix": "<exact replacement if canAutoFix, else omit>" }]

Guidelines: missing frontmatter with sensible defaults, invalid type/status/relevance with an obvious value, and tag formatting can be auto-fixed. Broken wiki-links and structural issues need human review.`;

  try {
    const text = await cli.completions.complete({ prompt, maxTokens: 2000 });
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as AuditFixResult[];
      return parsed.map((f) => ({
        path: f.path || "",
        issue: f.issue || "",
        suggestion: f.suggestion || "",
        canAutoFix: f.canAutoFix ?? false,
        fix: f.fix,
      }));
    }
  } catch {
    // Fall through to manual.
  }
  return manual();
}

export const auditCommand: CoreCommand = {
  summary: "Run staleness and quality audit",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const db = openReadonlyDb(cli.brain);
    try {
      const issues = audit(db, cli.brain.taxonomy);

      // Append module hygiene checks (each module runs against its own config).
      for (const mod of cli.brain.modules) {
        for (const check of mod.manifest.hygieneChecks ?? []) {
          try {
            const extra = await check({ db, root: cli.brain.root, config: mod.config });
            issues.push(...extra);
          } catch (e) {
            issues.push({
              path: "(module)",
              severity: "warning",
              category: "module-hygiene",
              message: `hygiene check from module "${mod.manifest.name}" failed: ${(e as Error).message}`,
            });
          }
        }
      }

      if (flags.fix === true) {
        const fixes = await suggestFixes(issues, cli);
        emit(cli.json, fixes, () => {
          if (fixes.length === 0) {
            console.log("No issues to fix.");
            return;
          }
          console.log(`${fixes.length} fix suggestion(s):\n`);
          for (const fix of fixes) {
            console.log(`  ${fix.path}${fix.canAutoFix ? " [auto-fixable]" : " [manual]"}`);
            console.log(`    Issue: ${fix.issue}`);
            console.log(`    Suggestion: ${fix.suggestion}`);
            if (fix.fix) console.log(`    Fix: ${fix.fix}`);
            console.log();
          }
        });
        return;
      }

      const errors = issues.filter((i) => i.severity === "error").length;
      const warnings = issues.filter((i) => i.severity === "warning").length;
      const infos = issues.filter((i) => i.severity === "info").length;

      emit(cli.json, { issues, errors, warnings, infos }, () => {
        if (issues.length === 0) {
          console.log("No issues found. The brain is healthy.");
          return;
        }
        const byLevel = (sev: AuditIssue["severity"], label: string) => {
          const group = issues.filter((i) => i.severity === sev);
          if (group.length === 0) return;
          console.log(`${label} (${group.length}):`);
          for (const i of group) {
            console.log(`  [${sev.toUpperCase()}] ${i.path}: ${i.message}`);
            if (i.suggestion) console.log(`            -> ${i.suggestion}`);
          }
          console.log();
        };
        byLevel("error", "ERRORS");
        byLevel("warning", "WARNINGS");
        byLevel("info", "INFO");
        console.log(`Summary: ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`);
      });
    } finally {
      db.close();
    }
  },
};
