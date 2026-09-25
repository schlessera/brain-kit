/**
 * The always-loaded instruction weight `brain doctor` reports: what every
 * session pays for before any work starts. That is CLAUDE.md with its `@`
 * imports resolved one level, AGENTS.md, and the description of every skill a
 * model may invoke on its own, each estimated as characters / 4 like
 * `brain context`.
 */

import { readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

import { estimateTokens } from "./context-assembler.js";
import { codeRanges, inRanges } from "./markdown-code.js";
import type { LoadedModule } from "./module-types.js";
import { discoverSkills } from "./skills/discover.js";

export interface InstructionsWeight {
  /** Every counted file and skill description, in load order. */
  contributors: { name: string; tokens: number }[];
  /** Deliberately not counted: an import that resolves outside the brain. */
  notes: string[];
  /** Could not be measured: the total is a lower bound while any are present. */
  problems: string[];
}

/**
 * `@path` imports in a CLAUDE.md, as Claude Code reads them: outside code (as
 * the GFM parse finds it, see markdown-code.ts), after whitespace or at a line
 * start. Home and absolute imports are left out; they live outside the brain.
 */
export function claudeImports(text: string): string[] {
  const code = codeRanges(text);
  const found: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    if (inRanges(code, m.index! + m[0].length - m[1].length - 1)) continue;
    const path = m[1];
    if (path.startsWith("~") || isAbsolute(path)) continue;
    found.push(path);
  }
  return found;
}

export function measureInstructions(root: string, modules: LoadedModule[]): InstructionsWeight {
  const contributors: InstructionsWeight["contributors"] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  const realRoot = realpathSync(root);
  const counted = new Set<string>();

  /**
   * The text of `rel` when it should count: a file whose real path is inside
   * the brain and not already counted under another name. `required` marks an
   * explicit import, whose absence is a measurement problem rather than an
   * optional file that is simply not there.
   */
  const read = (rel: string, required: boolean): string | null => {
    let real: string;
    try {
      real = realpathSync(resolve(root, rel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !required) return null;
      problems.push(`${rel}: ${code === "ENOENT" ? "not found" : (e as Error).message}`);
      return null;
    }
    const inside = relative(realRoot, real);
    if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) {
      notes.push(`${rel} resolves outside the brain and is not counted`);
      return null;
    }
    if (counted.has(real)) return null;
    try {
      if (!statSync(real).isFile()) {
        problems.push(`${rel}: not a file`);
        return null;
      }
      const text = readFileSync(real, "utf8");
      counted.add(real);
      return text;
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
      return null;
    }
  };

  const claude = read("CLAUDE.md", false);
  if (claude !== null) {
    contributors.push({ name: "CLAUDE.md", tokens: estimateTokens(claude) });
    for (const rel of claudeImports(claude)) {
      const text = read(rel, true);
      if (text !== null) contributors.push({ name: rel, tokens: estimateTokens(text) });
    }
  }
  const agents = read("AGENTS.md", false);
  if (agents !== null) contributors.push({ name: "AGENTS.md", tokens: estimateTokens(agents) });

  const discovered = discoverSkills({ root, modules });
  problems.push(...discovered.warnings);
  for (const skill of discovered.skills) {
    if (skill.frontmatter["disable-model-invocation"] === true) continue;
    contributors.push({ name: `skill ${skill.name}`, tokens: estimateTokens(skill.description) });
  }

  return { contributors, notes, problems };
}
