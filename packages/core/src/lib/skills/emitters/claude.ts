/**
 * "claude" emitter — symlinks each skill into `.claude/skills/<name>`.
 *
 * This is today's `scripts/hooks/sync-skills` behavior verbatim: relative
 * `../../.agents/skills/<name>` links, Windows junction fallback (via
 * fs-links.makeLink), stale-link pruning, and never clobbering a real
 * file/dir that already occupies the target path.
 */

import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { linkSkillsInto } from "../fs-links.js";

export const claudeEmitter: SkillEmitter = {
  agent: "claude",
  emit(skills, repoRoot) {
    const { linked, pruned } = linkSkillsInto(
      join(repoRoot, ".claude", "skills"),
      skills.map((skill) => ({ name: skill.name, target: `../../.agents/skills/${skill.name}` }))
    );
    return {
      written: linked.map((name) => `.claude/skills/${name}`),
      removed: pruned.map((name) => `.claude/skills/${name}`),
    };
  },
};
