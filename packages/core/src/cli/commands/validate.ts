import { validate, checkIndexDrift } from "../../lib/validate";
import type { ValidationIssue } from "../../lib/validate";
import type { CoreCommand } from "../types";
import { emit } from "../io";

/**
 * Config validation runs first (plan/01 §2): a schema-invalid brain.config is
 * reported and the command refuses before touching the corpus. Otherwise the
 * config is already known-good (initContext validated it), and validate() +
 * checkIndexDrift() cover the corpus and the index. Exits 1 when any
 * error-level issue is found so hooks/CI can gate on it.
 */
export const validateCommand: CoreCommand = {
  summary: "Run config, frontmatter, link, and index-drift validation",
  helpBlock: "brain validate — config check, then frontmatter + wiki-link + index-drift validation.",
  async run(_args, cli): Promise<number> {
    if (cli.configError) {
      const payload = {
        ok: false,
        configError: cli.configError,
        issues: [] as ValidationIssue[],
        errors: 1,
        warnings: 0,
      };
      emit(cli.json, payload, () => {
        console.log("Config validation failed:");
        console.log(cli.configError);
      });
      return 1;
    }

    const corpusIssues = validate(cli.brain.root, cli.brain.taxonomy);
    const driftIssues = await checkIndexDrift(cli.brain.root, cli.brain.dbPath, cli.brain.taxonomy);
    const issues = [...corpusIssues, ...driftIssues];

    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.filter((i) => i.level === "warning").length;

    emit(cli.json, { ok: errors === 0, issues, errors, warnings }, () => {
      if (issues.length === 0) {
        console.log("Validation passed. No issues found.");
        return;
      }
      for (const i of issues) {
        const tag = i.level === "error" ? "[ERROR]" : "[WARN] ";
        console.log(`  ${tag} ${i.file}: ${i.message}`);
      }
      console.log();
      console.log(`Summary: ${errors} error(s), ${warnings} warning(s)`);
    });

    return errors > 0 ? 1 : 0;
  },
};
