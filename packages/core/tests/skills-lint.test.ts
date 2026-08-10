import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { lintSkills, type LintFinding } from "../src/lib/skills/lint";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "bf-lint-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

interface SkillSpec {
  name?: string;
  description?: string;
  extraFm?: Record<string, unknown>;
  body?: string;
}

/** Write a skill dir + SKILL.md and return a manifest pointing at it. */
function mkSkill(dirName: string, spec: SkillSpec): SkillManifest {
  const root = mkRoot();
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });

  const fm: Record<string, unknown> = {};
  if (spec.name !== undefined) fm.name = spec.name;
  if (spec.description !== undefined) fm.description = spec.description;
  Object.assign(fm, spec.extraFm ?? {});
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${yaml}\n---\n\n${spec.body ?? "Body."}\n`);

  return {
    name: spec.name ?? dirName,
    description: spec.description ?? "",
    dir,
    source: "local",
    frontmatter: fm,
  };
}

const shellBlock = (cmd: string) => ["Run:", "```bash", cmd, "```"].join("\n");
const rulesOf = (findings: LintFinding[]) => findings.map((f) => f.rule);

describe("lint rules — one fixture per rule", () => {
  test("clean skill produces no findings", () => {
    const s = mkSkill("clean", {
      name: "clean",
      description: "A well-formed skill.",
      body: shellBlock("brain search foo"),
    });
    expect(lintSkills([s])).toEqual([]);
  });

  test("name not matching directory → error", () => {
    const s = mkSkill("wrong-dir", { name: "right-name", description: "d" });
    const findings = lintSkills([s]);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "name-matches-dir", severity: "error" })
    );
  });

  test("missing description → error", () => {
    const s = mkSkill("nodesc", { name: "nodesc" });
    const findings = lintSkills([s]);
    expect(findings.some((f) => f.rule === "frontmatter" && f.severity === "error")).toBe(true);
  });

  test("Claude-only tool in body → error", () => {
    const s = mkSkill("uses-todo", {
      name: "uses-todo",
      description: "d",
      body: "First call TodoWrite to plan the work.",
    });
    const findings = lintSkills([s]);
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: "claude-only-tool", severity: "error" })
    );
  });

  test("Claude-only tool inside an agent:claude section is allowed", () => {
    const s = mkSkill("guarded", {
      name: "guarded",
      description: "d",
      body: "Normally use brain.\n\n<!-- agent:claude -->\nUse TodoWrite here.\n<!-- /agent:claude -->\n",
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("claude-only-tool");
  });

  test('"Claude should…" phrasing → warning', () => {
    const s = mkSkill("acting", {
      name: "acting",
      description: "d",
      body: "Claude should read the file before editing.",
    });
    expect(lintSkills([s])).toContainEqual(
      expect.objectContaining({ rule: "acting-agent", severity: "warning" })
    );
  });

  test("undeclared shell command → warning", () => {
    const s = mkSkill("uses-git", {
      name: "uses-git",
      description: "d",
      body: shellBlock("git status"),
    });
    const gitFinding = lintSkills([s]).find((f) => f.rule === "shell-command");
    expect(gitFinding?.severity).toBe("warning");
    expect(gitFinding?.message).toContain("git");
  });

  test("shell command declared in requires: is allowed", () => {
    const s = mkSkill("declared-git", {
      name: "declared-git",
      description: "d",
      extraFm: { requires: ["git"] },
      body: shellBlock("git status"),
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("shell-command");
  });

  test("brain commands are always allowed", () => {
    const s = mkSkill("brainly", {
      name: "brainly",
      description: "d",
      body: shellBlock("brain audit --json"),
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("shell-command");
  });

  test("Claude-specific frontmatter keys → info", () => {
    const s = mkSkill("claude-fm", {
      name: "claude-fm",
      description: "d",
      extraFm: { "allowed-tools": "Bash", "disable-model-invocation": true },
    });
    const findings = lintSkills([s]).filter((f) => f.rule === "claude-specific-frontmatter");
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "info")).toBe(true);
  });

  test("absolute path in body → warning", () => {
    const s = mkSkill("abs-path", {
      name: "abs-path",
      description: "d",
      body: "Read the file at /home/alex/brain/me/identity.md before starting.",
    });
    const findings = lintSkills([s]).filter((f) => f.rule === "absolute-path");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("/home/alex/brain/me/identity.md");
  });

  test("URLs are not flagged as absolute paths", () => {
    const s = mkSkill("has-url", {
      name: "has-url",
      description: "d",
      body: "See https://example.com/docs/guide for details.",
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("absolute-path");
  });

  test("lintSkills aggregates across multiple skills", () => {
    const a = mkSkill("a-ok", { name: "a-ok", description: "d", body: shellBlock("brain add") });
    const b = mkSkill("b-bad", { name: "b-bad", description: "d", body: "Claude should do it." });
    const findings = lintSkills([a, b]);
    expect(findings.every((f) => f.skill === "b-bad")).toBe(true);
  });
});
