import { syncSkills, installBinLinks } from "../../lib/skills";
import type { CoreCommand } from "../types";
import { emit } from "../io";
import { resolveEmitters } from "../skills-util";
import { installGitHooks } from "../hooks-util";

const HELP = `brain setup — idempotent first-run wiring

Installs the packaged git hooks (copied into .githooks/ + core.hooksPath set),
syncs skills into per-agent locations, and links the brain CLI into ~/.local/bin.
Safe to re-run.`;

export const setupCommand: CoreCommand = {
  summary: "Idempotent setup: git hooks, skills sync, bin links",
  helpBlock: HELP,
  async run(_args, cli) {
    const root = cli.brain.root;
    const result: Record<string, unknown> = {};
    const warnings: string[] = [];

    // 1. Git hooks — copied into .githooks/ + core.hooksPath set.
    const hooks = installGitHooks(root);
    if (!hooks.installed) warnings.push("not a git repository — skipped git hooks");
    result.hooksPath = hooks.hooksPath;
    result.hooks = hooks.hooks;

    // 2. Skills sync (claude emitter always + configured emitters).
    const { emitters, warnings: emitterWarnings } = resolveEmitters(cli.brain);
    warnings.push(...emitterWarnings);
    const skills = syncSkills({ root, modules: cli.brain.modules }, { emitters });
    result.skills = {
      materialized: skills.materialized,
      pruned: skills.pruned,
      emitters: skills.emitters,
    };
    warnings.push(...skills.warnings);

    // 3. Bin links (~/.local/bin/brain → the repo's pinned CLI).
    const bin = installBinLinks(root);
    result.binLinks = bin.linked;
    warnings.push(...bin.warnings);

    result.warnings = warnings;

    emit(cli.json, result, () => {
      console.log("brain setup complete:");
      console.log(`  git hooks:  ${hooks.installed ? `${hooks.hooks.join(", ")} (core.hooksPath=.githooks)` : "skipped (not a git repo)"}`);
      console.log(`  skills:     ${skills.materialized.length} materialized, ${skills.pruned.length} pruned`);
      console.log(`  bin links:  ${bin.linked.length ? bin.linked.join(", ") : "none"}`);
      for (const w of warnings) console.log(`  warning: ${w}`);
    });
  },
};
