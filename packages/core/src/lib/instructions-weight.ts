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
 * `markdown` with every code region blanked: fenced blocks (backtick or tilde,
 * three or more, closed only by a run of the same character at least as long,
 * or running to the end when never closed) and inline code spans (a backtick
 * run closed by the next run of exactly the same length; an unmatched run is
 * literal text). Line structure is kept.
 */
export function stripMarkdownCode(markdown: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      lines.push("");
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      lines.push("");
      continue;
    }
    lines.push(line);
  }
  const prose = lines.join("\n");

  let out = "";
  let i = 0;
  while (i < prose.length) {
    if (prose[i] !== "`") {
      out += prose[i++];
      continue;
    }
    let n = 0;
    while (prose[i + n] === "`") n++;
    let close = -1;
    for (let j = i + n; j < prose.length; ) {
      if (prose[j] !== "`") {
        j++;
        continue;
      }
      let m = 0;
      while (prose[j + m] === "`") m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      out += prose.slice(i, i + n);
      i += n;
    } else {
      out += prose.slice(i, close + n).replace(/[^\n]/g, " ");
      i = close + n;
    }
  }
  return out;
}

/**
 * `@path` imports in a CLAUDE.md, as Claude Code reads them: outside code,
 * after whitespace or at a line start. Home and absolute imports are left
 * out; they live outside the brain.
 */
export function claudeImports(text: string): string[] {
  const found: string[] = [];
  for (const m of stripMarkdownCode(text).matchAll(/(?:^|\s)@(\S+)/g)) {
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
