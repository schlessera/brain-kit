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

  test("shell command declared in requires: is still allowed", () => {
    const s = mkSkill("declared-git", {
      name: "declared-git",
      description: "d",
      extraFm: { requires: ["git"] },
      body: shellBlock("git status"),
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("shell-command");
  });

  test("requires: itself warns as non-spec frontmatter", () => {
    // The specification allows six keys and rejects anything else outright, so
    // `requires:` keeps working but tells the author where it moved.
    const s = mkSkill("legacy-requires", {
      name: "legacy-requires",
      description: "d",
      extraFm: { requires: ["git", "jq"] },
      body: shellBlock("git status"),
    });
    const finding = lintSkills([s]).find((f) => f.rule === "non-spec-frontmatter");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("compatibility:");
    expect(finding?.message).toContain("Requires git and jq");
  });

  test("shell command named in compatibility: is allowed", () => {
    const s = mkSkill("compat-git", {
      name: "compat-git",
      description: "d",
      extraFm: { compatibility: "Requires git." },
      body: shellBlock("git status"),
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("shell-command");
    expect(rulesOf(lintSkills([s]))).not.toContain("non-spec-frontmatter");
  });

  test("compatibility: matches on whole words only", () => {
    // "github" must not satisfy `git`, and a name is not satisfied by a prefix
    // of a longer one.
    const s = mkSkill("compat-github", {
      name: "compat-github",
      description: "d",
      extraFm: { compatibility: "Requires github access and git-lfs." },
      body: shellBlock("git status"),
    });
    expect(rulesOf(lintSkills([s]))).toContain("shell-command");
  });

  test("compatibility: tolerates a trailing sentence period", () => {
    const s = mkSkill("compat-period", {
      name: "compat-period",
      description: "d",
      extraFm: { compatibility: "Requires bun." },
      body: shellBlock("bun test"),
    });
    expect(rulesOf(lintSkills([s]))).not.toContain("shell-command");
  });

  test("compatibility: keeps dotted names intact", () => {
    const s = mkSkill("compat-dotted", {
      name: "compat-dotted",
      description: "d",
      extraFm: { compatibility: "Requires docker.io." },
      body: shellBlock("docker compose up"),
    });
    expect(rulesOf(lintSkills([s]))).toContain("shell-command");
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
      body: "Read the file at /home/odysseus/brain/me/identity.md before starting.",
    });
    const findings = lintSkills([s]).filter((f) => f.rule === "absolute-path");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("/home/odysseus/brain/me/identity.md");
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

describe("manual-only-policy — disable-model-invocation vs agents/openai.yaml", () => {
  const manualOnly = { "disable-model-invocation": true };
  const withYaml = (s: SkillManifest, yaml: string) => {
    mkdirSync(join(s.dir, "agents"), { recursive: true });
    writeFileSync(join(s.dir, "agents", "openai.yaml"), yaml);
    return s;
  };
  const policy = (s: SkillManifest) =>
    lintSkills([s]).filter((f) => f.rule === "manual-only-policy");

  test("manual-only skill without the yaml → warning", () => {
    const s = mkSkill("manual", { name: "manual", description: "d", extraFm: manualOnly });
    const found = policy(s);
    expect(found.map((f) => f.severity)).toEqual(["warning"]);
    expect(found[0].message).toContain("Codex can still invoke it");
  });

  test("manual-only skill whose yaml allows implicit invocation → warning", () => {
    const s = withYaml(
      mkSkill("manual", { name: "manual", description: "d", extraFm: manualOnly }),
      "policy:\n  allow_implicit_invocation: true\n"
    );
    expect(policy(s).map((f) => f.severity)).toEqual(["warning"]);
  });

  test("yaml forbids implicit invocation but the frontmatter does not → warning", () => {
    const s = withYaml(
      mkSkill("auto", { name: "auto", description: "d" }),
      "policy:\n  allow_implicit_invocation: false\n"
    );
    const found = policy(s);
    expect(found.map((f) => f.severity)).toEqual(["warning"]);
    expect(found[0].message).toContain("Claude Code can still invoke it");
  });

  test("an unparseable yaml → warning", () => {
    const s = withYaml(
      mkSkill("manual", { name: "manual", description: "d", extraFm: manualOnly }),
      "policy: [unclosed\n"
    );
    expect(policy(s)[0].message).toContain("could not be parsed");
  });

  test("agreeing flag and yaml, or neither → no finding", () => {
    const agreeing = withYaml(
      mkSkill("manual", { name: "manual", description: "d", extraFm: manualOnly }),
      "policy:\n  allow_implicit_invocation: false\n"
    );
    const neither = mkSkill("auto", { name: "auto", description: "d" });
    expect(policy(agreeing)).toEqual([]);
    expect(policy(neither)).toEqual([]);
  });
});

describe("manual-only-without-flag — a description that says manual-only", () => {
  const found = (s: SkillManifest) => lintSkills([s]).filter((f) => f.rule === "manual-only-without-flag");
  const description = "Deploys the site. MANUAL INVOCATION ONLY: run it when the user asks.";

  test("without disable-model-invocation → warning naming the cost and the fix", () => {
    const s = mkSkill("deploy", { name: "deploy", description });
    const hits = found(s);
    expect(hits.map((f) => f.severity)).toEqual(["warning"]);
    expect(hits[0].message).toContain('"MANUAL INVOCATION ONLY"');
    expect(hits[0].message).toContain(`~${Math.ceil(description.length / 4)} tokens`);
    expect(hits[0].message).toContain("disable-model-invocation: true");
  });

  test("with the flag → no finding", () => {
    const s = mkSkill("deploy", {
      name: "deploy",
      description,
      extraFm: { "disable-model-invocation": true },
    });
    expect(found(s)).toEqual([]);
  });

  for (const phrase of [
    "Manual-only.",
    "Use only when the user explicitly asks for a deploy.",
    "Never invoke automatically.",
    "Do not invoke this skill automatically.",
  ]) {
    test(`"${phrase}" is recognised`, () => {
      expect(found(mkSkill("deploy", { name: "deploy", description: `Deploys the site. ${phrase}` }))).toHaveLength(1);
    });
  }

  // Review round 1: none of these makes the skill manual-only, and following
  // the suggested fix would stop a model from ever invoking it.
  for (const description of [
    'Explains the phrase "manual invocation only" in skill documentation.',
    "Explains the \u201cmanual-only\u201d label in skill docs.",
    "Documents `never invoke automatically` markers.",
    'Explains labels such as "Deploy. Manual-only." in skill docs.',
    "Documents markers such as `Deploy. Never invoke automatically.` in skill docs.",
    "Manage files automatically; delete files only when the user explicitly requests deletion.",
    "Not manual-only; use automatically.",
    "This skill is not manual-only.",
    "Tells authors when to mark a skill manual invocation only.",
    "Runs on a schedule and must never invoke automatically any paid API.",
  ]) {
    test(`not a policy about the skill: ${description}`, () => {
      expect(found(mkSkill("deploy", { name: "deploy", description }))).toEqual([]);
    });
  }

  for (const description of [
    "Deploys the site (manual-only).",
    "Deploys the site, manual invocation only.",
    "This skill is manual-only.",
    "Deploys the site - do not run it automatically.",
  ]) {
    test(`a policy clause anywhere in the description: ${description}`, () => {
      expect(found(mkSkill("deploy", { name: "deploy", description }))).toHaveLength(1);
    });
  }

  test("a description that only mentions manual steps is not judged", () => {
    const s = mkSkill("deploy", { name: "deploy", description: "Use when a deploy needs manual steps." });
    expect(found(s)).toEqual([]);
  });
});
