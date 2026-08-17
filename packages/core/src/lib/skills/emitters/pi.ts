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

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { isSymlink, makeLink, normalizeLinkTarget, readLink } from "../fs-links.js";

export const piEmitter: SkillEmitter = {
  agent: "pi",
  emit(skills, repoRoot) {
    const written: string[] = [];
    const removed: string[] = [];

    const piDir = join(repoRoot, ".pi", "skills");
    mkdirSync(piDir, { recursive: true });

    const want = new Set(skills.map((s) => s.name));

    for (const skill of skills) {
      const link = join(piDir, skill.name);
      const relTarget = `../../.agents/skills/${skill.name}`;

      if (isSymlink(link)) {
        if (normalizeLinkTarget(readLink(link) ?? "") === relTarget) continue; // already correct
        rmSync(link);
      } else if (existsSync(link)) {
        continue; // a real file/dir lives here — never clobber it
      }

      if (makeLink(relTarget, link, true)) written.push(`.pi/skills/${skill.name}`);
    }

    // Prune stale skill symlinks (removed/renamed skills). Real dirs untouched.
    for (const entry of readdirSync(piDir)) {
      const p = join(piDir, entry);
      if (isSymlink(p) && !want.has(entry)) {
        rmSync(p);
        removed.push(`.pi/skills/${entry}`);
      }
    }

    return { written, removed };
  },
};
