import type { AuditIssue } from "../../lib/types.js";
import { auditFixSuggester } from "../../lib/audit-repair.js";
import { auditTotals, auditWithModules } from "../../lib/auditor.js";
import type { CoreCommand } from "../types.js";
import { emit, openReadonlyDb, parseArgs } from "../io.js";

const HELP = `brain audit — staleness and quality audit

  --fix                   Report deterministic repair availability and suggestions
                          (no provider call; applies nothing)

--json envelope: { "issues": AuditIssue[], "errors", "warnings", "infos",
"mustFix", "informational" } (markdown documents only — assets excluded).
Each count is findings, not markers: a document's TODO markers are one
finding, and so are its VERIFY markers. Must-fix is errors plus warnings;
informational is infos.`;

export const auditCommand: CoreCommand = {
  summary: "Run staleness and quality audit",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);
    const db = openReadonlyDb(cli.brain);
    try {
      const issues = await auditWithModules(db, cli.brain);

      if (flags.fix === true) {
        const asOf = new Date().toISOString().slice(0, 10);
        const fixes = issues.map(auditFixSuggester(cli.brain.root, cli.brain.taxonomy, asOf));
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
            if (fix.repair) console.log(`    Repair capability: ${fix.repair.capability} (${fix.repair.path})`);
            console.log();
          }
        });
        return;
      }

      const { errors, warnings, infos, mustFix, informational } = auditTotals(issues);

      emit(cli.json, { issues, errors, warnings, infos, mustFix, informational }, () => {
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
        console.log(`         ${mustFix} must-fix (errors and warnings), ${informational} informational (infos)`);
      });
    } finally {
      db.close();
    }
  },
};
