/**
 * `lintSkills(skills)` — the skill lint rules from plan/04 §2, verbatim.
 *
 * | Rule                                                        | Severity |
 * |-------------------------------------------------------------|----------|
 * | frontmatter has name + description; name matches directory  | error    |
 * | body references a Claude-only tool outside an agent:claude section | error |
 * | "Claude should…" acting-agent phrasing                      | warning  |
 * | shell command that is neither `brain …` nor in `requires:`  | warning  |
 * | allowed-tools / disable-model-invocation present            | info     |
 * | absolute path in body                                       | warning  |
 *
 * SkillManifest carries no body, so the body-based rules re-read the skill's
 * SKILL.md from disk.
 */

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import matter from "gray-matter";

import type { SkillManifest } from "../seams";

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  skill: string;
  rule: string;
  severity: LintSeverity;
  message: string;
}

const CLAUDE_ONLY_TOOLS = ["AskUserQuestion", "TodoWrite", "EnterPlanMode"];
const CLAUDE_SPECIFIC_KEYS = ["allowed-tools", "disable-model-invocation"];
const SHELL_FENCE_LANGS = new Set(["", "sh", "bash", "shell", "zsh", "console"]);
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "return", "exit", "cd", "echo", "true", "false", "set", "export",
  "EOF", "eof",
]);

export function lintSkills(skills: SkillManifest[]): LintFinding[] {
  return skills.flatMap(lintSkill);
}

function lintSkill(skill: SkillManifest): LintFinding[] {
  const findings: LintFinding[] = [];
  const skillName = skill.name || basename(skill.dir);
  const add = (rule: string, severity: LintSeverity, message: string) =>
    findings.push({ skill: skillName, rule, severity, message });

  // Load body + frontmatter from disk (the manifest carries neither the body
  // nor a guaranteed-complete frontmatter for lint's purposes).
  const skillFile = join(skill.dir, "SKILL.md");
  let body = "";
  let frontmatter: Record<string, unknown> = skill.frontmatter ?? {};
  if (existsSync(skillFile)) {
    try {
      const parsed = matter(readFileSync(skillFile, "utf8"));
      body = parsed.content;
      frontmatter = parsed.data as Record<string, unknown>;
    } catch (e) {
      add("frontmatter", "error", `could not parse SKILL.md: ${(e as Error).message}`);
    }
  } else {
    add("frontmatter", "error", `SKILL.md not found at ${skillFile}`);
  }

  // Rule: name + description present; name matches directory.
  const dirName = basename(skill.dir);
  const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : skill.name;
  const description =
    typeof frontmatter.description === "string" && frontmatter.description
      ? frontmatter.description
      : skill.description;
  if (!name) add("frontmatter", "error", "missing `name` in frontmatter");
  if (!description) add("frontmatter", "error", "missing `description` in frontmatter");
  if (name && name !== dirName) {
    add("name-matches-dir", "error", `name "${name}" does not match directory "${dirName}"`);
  }

  // Rule: Claude-specific frontmatter keys → info.
  for (const key of CLAUDE_SPECIFIC_KEYS) {
    if (key in frontmatter) {
      add(
        "claude-specific-frontmatter",
        "info",
        `\`${key}\` is Claude-specific and ignored by other agents`
      );
    }
  }

  // Rule: Claude-only tool references (outside an <!-- agent:claude --> section) → error.
  const bodyOutsideClaude = stripClaudeSections(body);
  for (const tool of CLAUDE_ONLY_TOOLS) {
    if (new RegExp(`\\b${tool}\\b`).test(bodyOutsideClaude)) {
      add(
        "claude-only-tool",
        "error",
        `references Claude-only tool \`${tool}\` outside an <!-- agent:claude --> section`
      );
    }
  }
  if (/\bTask\(/.test(bodyOutsideClaude)) {
    add(
      "claude-only-tool",
      "error",
      "references Claude-only tool `Task(` outside an <!-- agent:claude --> section"
    );
  }

  // Rule: "Claude should…" acting-agent phrasing → warning (first hit).
  const acting = body.match(
    /\bClaude\s+(should|shall|must|will|would|can|could|needs?\s+to|is\s+expected\s+to)\b/i
  );
  if (acting) {
    add(
      "acting-agent",
      "warning",
      `"${acting[0].trim()}" names Claude as the acting agent; prefer "the agent"`
    );
  }

  // Rule: absolute paths in body → warning (deduped).
  for (const p of findAbsolutePaths(body)) {
    add("absolute-path", "warning", `absolute path "${p}" in body; prefer repo-relative paths`);
  }

  // Rule: shell commands must be `brain …` or declared in `requires:` → warning.
  const requires = Array.isArray(frontmatter.requires)
    ? (frontmatter.requires as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const allowed = new Set(requires);
  for (const cmd of findShellCommands(body)) {
    if (cmd === "brain" || allowed.has(cmd)) continue;
    add(
      "shell-command",
      "warning",
      `shell command \`${cmd}\` is neither \`brain …\` nor declared in \`requires:\``
    );
  }

  return findings;
}

/** Remove `<!-- agent:claude --> … <!-- /agent:claude -->` regions. */
function stripClaudeSections(body: string): string {
  return body.replace(
    /<!--\s*agent:claude\s*-->[\s\S]*?<!--\s*\/agent:claude\s*-->/g,
    ""
  );
}

/** Distinct absolute paths (`/a/b…`, ≥2 segments) not part of a URL. */
function findAbsolutePaths(body: string): string[] {
  const found = new Set<string>();
  // The leading boundary class excludes `:` and `/`, so `http://host/a/b` and
  // protocol-relative `//host/a` do not match.
  const re = /(^|[\s(`"'])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    found.add(m[2]);
  }
  return [...found];
}

/** Distinct leading command tokens inside shell code fences. */
function findShellCommands(body: string): string[] {
  const commands = new Set<string>();
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let block: RegExpExecArray | null;
  while ((block = fence.exec(body))) {
    const lang = (block[1].trim().toLowerCase().split(/\s+/)[0] ?? "");
    if (!SHELL_FENCE_LANGS.has(lang)) continue;

    for (const rawLine of block[2].split("\n")) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      line = line.replace(/^\$\s+/, ""); // strip shell prompt
      if (/^[A-Za-z_]\w*=/.test(line)) continue; // FOO=bar assignment
      const token = line.match(/^([A-Za-z_][\w./-]*)/);
      if (!token) continue;
      if (SHELL_KEYWORDS.has(token[1])) continue;
      commands.add(token[1]);
    }
  }
  return [...commands];
}
