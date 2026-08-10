/**
 * "codex" emitter — writes `.codex/prompts/<name>.md` (SKILL.md body with
 * Claude-specific frontmatter keys stripped, keeping only name + description)
 * and maintains the machine-managed Skills index block in AGENTS.md.
 *
 * The index block doubles as the record of which skills we previously managed:
 * prompt files are pruned only for names that were in the last block and are no
 * longer present, so hand-authored prompts are never deleted.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

import type { SkillEmitter, SkillManifest } from "../../seams.js";
import { readManagedNames, upsertIndexBlock } from "./index-block.js";

/** SKILL.md rewritten with frontmatter reduced to name + description. */
function renderPrompt(skill: SkillManifest): string {
  let body = "";
  try {
    body = matter(readFileSync(join(skill.dir, "SKILL.md"), "utf8")).content.replace(/^\n+/, "");
  } catch {
    body = "";
  }
  // JSON-encode the scalars: a JSON string is a valid YAML double-quoted scalar,
  // so descriptions containing colons/quotes stay well-formed.
  const frontmatter =
    `---\n` +
    `name: ${JSON.stringify(skill.name)}\n` +
    `description: ${JSON.stringify(skill.description)}\n` +
    `---\n`;
  return body ? `${frontmatter}\n${body.replace(/\s+$/, "")}\n` : frontmatter;
}

export const codexEmitter: SkillEmitter = {
  agent: "codex",
  emit(skills, repoRoot) {
    const written: string[] = [];
    const removed: string[] = [];

    const promptsDir = join(repoRoot, ".codex", "prompts");
    mkdirSync(promptsDir, { recursive: true });

    const agentsFile = join(repoRoot, "AGENTS.md");
    const previouslyManaged = readManagedNames(agentsFile);
    const currentNames = new Set(skills.map((s) => s.name));

    for (const skill of skills) {
      const target = join(promptsDir, `${skill.name}.md`);
      const content = renderPrompt(skill);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (existing !== content) {
        writeFileSync(target, content);
        written.push(`.codex/prompts/${skill.name}.md`);
      }
    }

    for (const name of previouslyManaged) {
      if (currentNames.has(name)) continue;
      const stale = join(promptsDir, `${name}.md`);
      if (existsSync(stale)) {
        rmSync(stale);
        removed.push(`.codex/prompts/${name}.md`);
      }
    }

    if (upsertIndexBlock(agentsFile, skills)) written.push("AGENTS.md");

    return { written, removed };
  },
};
