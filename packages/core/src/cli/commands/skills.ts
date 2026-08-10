import { discoverSkills, lintSkills, syncSkills } from "../../lib/skills/index.js";
import type { LintFinding } from "../../lib/skills/index.js";
import type { CoreCommand } from "../types.js";
import { emit, UsageError } from "../io.js";
import { resolveEmitters } from "../skills-util.js";

const HELP = `brain skills <sync|lint>

  sync   Materialize skills into .agents/skills and run per-agent emitters
  lint   Lint discovered skills; discovery warnings (unparseable frontmatter)
         are treated as ERRORS. Exits 1 on any error.`;

export const skillsCommand: CoreCommand = {
  summary: "Distribute (sync) or lint the skill suite",
  helpBlock: HELP,
  async run(args, cli): Promise<number | void> {
    const sub = args[0];
    const sources = { root: cli.brain.root, modules: cli.brain.modules };

    if (sub === "sync") {
      const { emitters, warnings } = resolveEmitters(cli.brain);
      const result = syncSkills(sources, { emitters });
      const allWarnings = [...warnings, ...result.warnings];
      emit(cli.json, { ...result, warnings: allWarnings }, () => {
        console.log(`Skills synced: ${result.materialized.length} materialized, ${result.pruned.length} pruned`);
        for (const e of result.emitters) {
          console.log(`  ${e.agent}: ${e.written.length} written, ${e.removed.length} removed`);
        }
        for (const w of allWarnings) console.log(`  warning: ${w}`);
      });
      return;
    }

    if (sub === "lint") {
      const { skills, warnings } = discoverSkills(sources);
      const findings: LintFinding[] = lintSkills(skills);

      // Discovery warnings (unparseable/missing frontmatter) are lint ERRORS.
      for (const w of warnings) {
        const hint = /frontmatter/i.test(w)
          ? " — quote description values containing ': ' (e.g. description: \"Foo: bar\")"
          : "";
        findings.push({ skill: "(discovery)", rule: "frontmatter", severity: "error", message: w + hint });
      }

      const errors = findings.filter((f) => f.severity === "error").length;
      const warns = findings.filter((f) => f.severity === "warning").length;
      const infos = findings.filter((f) => f.severity === "info").length;

      emit(cli.json, { findings, errors, warnings: warns, infos }, () => {
        if (findings.length === 0) {
          console.log("Skills lint: clean.");
          return;
        }
        for (const f of findings) {
          console.log(`  [${f.severity.toUpperCase()}] ${f.skill} (${f.rule}): ${f.message}`);
        }
        console.log(`\nSummary: ${errors} error(s), ${warns} warning(s), ${infos} info(s)`);
      });
      return errors > 0 ? 1 : 0;
    }

    throw new UsageError("Usage: brain skills <sync|lint>");
  },
};
