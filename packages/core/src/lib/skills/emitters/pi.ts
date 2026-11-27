/**
 * "pi" emitter — symlinks each skill into `.pi/skills/<name>`.
 *
 * pi discovers skills from two places: `<agentDir>/skills` (user level,
 * `$PI_AGENT_DIR` or `~/.pi/agent`) and `<cwd>/.pi/skills` (project level).
 * It does not read `.agents/skills/`, so without this emitter a brain's skills
 * are invisible to it even though they sit one directory away.
 *
 * Structurally identical to the claude emitter — relative links into the
 * canonical `.agents/skills/` home, a Windows junction fallback, stale-link
 * pruning, and never clobbering a real file or directory at the target path.
 * Symlinks rather than copies, so a skill has exactly one source of truth.
 */

import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { linkSkillsInto } from "../fs-links.js";

export const piEmitter: SkillEmitter = {
  agent: "pi",
  emit(skills, repoRoot) {
    const { linked, pruned } = linkSkillsInto(
      join(repoRoot, ".pi", "skills"),
      skills.map((skill) => ({ name: skill.name, target: `../../.agents/skills/${skill.name}` }))
    );
    return {
      written: linked.map((name) => `.pi/skills/${name}`),
      removed: pruned.map((name) => `.pi/skills/${name}`),
    };
  },
};
