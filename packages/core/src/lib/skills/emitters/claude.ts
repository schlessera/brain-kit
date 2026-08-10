/**
 * "claude" emitter — symlinks each skill into `.claude/skills/<name>`.
 *
 * This is today's `scripts/hooks/sync-skills` behavior verbatim: relative
 * `../../.agents/skills/<name>` links, Windows junction fallback (via
 * fs-links.makeLink), stale-link pruning, and never clobbering a real
 * file/dir that already occupies the target path.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { isSymlink, makeLink, normalizeLinkTarget, readLink } from "../fs-links.js";

export const claudeEmitter: SkillEmitter = {
  agent: "claude",
  emit(skills, repoRoot) {
    const written: string[] = [];
    const removed: string[] = [];

    const claudeDir = join(repoRoot, ".claude", "skills");
    mkdirSync(claudeDir, { recursive: true });

    const want = new Set(skills.map((s) => s.name));

    for (const skill of skills) {
      const link = join(claudeDir, skill.name);
      const relTarget = `../../.agents/skills/${skill.name}`;

      if (isSymlink(link)) {
        if (normalizeLinkTarget(readLink(link) ?? "") === relTarget) continue; // already correct
        rmSync(link);
      } else if (existsSync(link)) {
        continue; // a real file/dir lives here — never clobber it
      }

      if (makeLink(relTarget, link, true)) written.push(`.claude/skills/${skill.name}`);
    }

    // Prune stale skill symlinks (removed/renamed skills). Real dirs untouched.
    for (const entry of readdirSync(claudeDir)) {
      const p = join(claudeDir, entry);
      if (isSymlink(p) && !want.has(entry)) {
        rmSync(p);
        removed.push(`.claude/skills/${entry}`);
      }
    }

    return { written, removed };
  },
};
