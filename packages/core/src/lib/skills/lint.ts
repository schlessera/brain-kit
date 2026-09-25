/**
 * `lintSkills(skills)` — the skill lint rules.
 *
 * | Rule                                                        | Severity |
 * |-------------------------------------------------------------|----------|
 * | frontmatter has name + description; name matches directory  | error    |
 * | body references a Claude-only tool outside an agent:claude section | error |
 * | "Claude should…" acting-agent phrasing                      | warning  |
 * | shell command that is neither `brain …` nor in `compatibility:` | warning |
 * | `requires:` present (not a specification field)              | warning  |
 * | allowed-tools / disable-model-invocation present            | info     |
 * | disable-model-invocation disagrees with agents/openai.yaml  | warning  |
 * | description says manual-only, no disable-model-invocation   | warning  |
 * | absolute path in body                                       | warning  |
 *
 * SkillManifest carries no body, so the body-based rules re-read the skill's
 * SKILL.md from disk.
 */

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import matter from "gray-matter";

import { estimateTokens } from "../context-assembler.js";
import type { SkillManifest } from "../seams.js";

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  skill: string;
  rule: string;
  severity: LintSeverity;
  message: string;
}

/**
 * Description phrases that say a skill must run only when the user asks for
 * it. Deliberately short: a description that says so in other words is not
 * judged.
 */
const MANUAL_ONLY_PHRASES = [
  /\bmanual[- ]invocation only\b/i,
  /\bmanual[- ]only\b/i,
  /\bonly when the user explicitly\b/i,
  /\b(?:never|do not|don't) invoke (?:it |this skill )?automatically\b/i,
];

const CLAUDE_ONLY_TOOLS = ["AskUserQuestion", "TodoWrite", "EnterPlanMode"];
const CLAUDE_SPECIFIC_KEYS = ["allowed-tools", "disable-model-invocation"];
// Only explicitly-tagged shell fences are linted: untagged fences carry ASCII
// trees, file listings, and sample output far more often than commands.
const SHELL_FENCE_LANGS = new Set(["sh", "bash", "shell", "zsh", "console"]);
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

  // Rule: Codex marks a manual-only skill in `agents/openai.yaml`, not in the
  // frontmatter, so the two must say the same thing → warning.
  const mismatch = manualOnlyMismatch(skill.dir, frontmatter["disable-model-invocation"] === true);
  if (mismatch) add("manual-only-policy", "warning", mismatch);

  // Rule: a description that says the skill is manual-only still loads into
  // every Claude Code session unless the flag keeps it out → warning.
  const manualPhrase = MANUAL_ONLY_PHRASES.map((re) => description?.match(re)?.[0]).find(Boolean);
  if (manualPhrase && frontmatter["disable-model-invocation"] !== true) {
    add(
      "manual-only-without-flag",
      "warning",
      `description says "${manualPhrase}" but the frontmatter lacks \`disable-model-invocation: true\`, so its ~${estimateTokens(description)} tokens load into every Claude Code session; add the flag (and agents/openai.yaml, see manual-only-policy)`
    );
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

  // Rule: `requires:` is not a specification field → warning.
  // The standard allows exactly six keys, and a skill carrying anything else is
  // rejected by claude.ai upload, the Skills API, and the reference validator.
  // `compatibility` is the sanctioned slot for the same statement, and reads
  // better besides: prose a human can act on rather than a bare token list.
  const legacyRequires = Array.isArray(frontmatter.requires)
    ? (frontmatter.requires as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (legacyRequires.length > 0) {
    add(
      "non-spec-frontmatter",
      "warning",
      `\`requires:\` is not a specification field; state it in \`compatibility:\` instead, e.g. "Requires ${legacyRequires.join(" and ")}"`
    );
  }

  // Rule: shell commands must be `brain …` or named in `compatibility:` → warning.
  const compatibility =
    typeof frontmatter.compatibility === "string" ? frontmatter.compatibility : "";
  for (const cmd of findShellCommands(body)) {
    if (cmd === "brain") continue;
    if (legacyRequires.includes(cmd)) continue; // honoured while it still exists
    if (mentionsWord(compatibility, cmd)) continue;
    add(
      "shell-command",
      "warning",
      `shell command \`${cmd}\` is neither \`brain …\` nor named in \`compatibility:\``
    );
  }

  return findings;
}

/**
 * Why a skill's `disable-model-invocation` and its `agents/openai.yaml`
 * `policy.allow_implicit_invocation` disagree, or null when they agree. Codex
 * defaults to implicit invocation, so a missing file or key means "allowed".
 */
function manualOnlyMismatch(skillDir: string, manualOnly: boolean): string | null {
  const file = join(skillDir, "agents", "openai.yaml");
  let allowImplicit: unknown = true;
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return `agents/openai.yaml could not be parsed: ${(e as Error).message}`;
    }
    const policy = (parsed as { policy?: { allow_implicit_invocation?: unknown } } | null)?.policy;
    allowImplicit = policy?.allow_implicit_invocation ?? true;
  }
  if (manualOnly && allowImplicit !== false) {
    return "`disable-model-invocation: true` but agents/openai.yaml does not set `policy.allow_implicit_invocation: false`, so Codex can still invoke it on its own";
  }
  if (!manualOnly && allowImplicit === false) {
    return "agents/openai.yaml sets `policy.allow_implicit_invocation: false` but the frontmatter lacks `disable-model-invocation: true`, so Claude Code can still invoke it on its own";
  }
  return null;
}

/**
 * Whether `text` names `word` as a whole word. Word-boundary rather than
 * substring so "Requires github access" does not silently satisfy a `git`
 * dependency, and dots in names like `docker.io` do not split.
 */
function mentionsWord(text: string, word: string): boolean {
  if (!text) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Trailing boundary: not a word character or hyphen, and not a dot that
  // continues a name. A sentence-ending "Requires git." still counts; "git-lfs"
  // and "docker.io" do not satisfy `git` / `docker`.
  return new RegExp(`(^|[^\\w.-])${escaped}(?![\\w-])(?!\\.[A-Za-z0-9])`).test(text);
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
