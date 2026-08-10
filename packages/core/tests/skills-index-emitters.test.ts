import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import matter from "gray-matter";

import { codexEmitter } from "../src/lib/skills/emitters/codex";
import { geminiEmitter } from "../src/lib/skills/emitters/gemini";
import { INDEX_END, INDEX_START } from "../src/lib/skills/emitters/index-block";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "bf-index-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A skill whose SKILL.md carries Claude-specific frontmatter keys + a body. */
function skill(root: string, name: string, description: string): SkillManifest {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "disable-model-invocation: true",
      "allowed-tools: Bash",
      "---",
      "",
      `# ${name}`,
      "",
      "Run the workflow.",
      "",
    ].join("\n")
  );
  return { name, description, dir, source: "core", frontmatter: {} };
}

describe("codexEmitter prompts + AGENTS.md index", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note into the brain.");
  const audit = skill(root, "audit", "Report hygiene issues: staleness, orphans.");
  const agentsFile = join(root, "AGENTS.md");
  const promptsDir = join(root, ".codex", "prompts");

  test("writes prompts with only name+description and preserves the body", () => {
    const res = codexEmitter.emit([add, audit], root);
    expect(res.written).toContain(".codex/prompts/add.md");
    expect(res.written).toContain("AGENTS.md");

    const parsed = matter(readFileSync(join(promptsDir, "add.md"), "utf8"));
    expect(Object.keys(parsed.data).sort()).toEqual(["description", "name"]);
    expect(parsed.data.name).toBe("add");
    expect(parsed.content).toContain("Run the workflow.");
  });

  test("AGENTS.md gains a sorted managed block", () => {
    const text = readFileSync(agentsFile, "utf8");
    expect(text).toContain(INDEX_START);
    expect(text).toContain(INDEX_END);
    const addAt = text.indexOf("- **add**");
    const auditAt = text.indexOf("- **audit**");
    expect(addAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(addAt); // sorted
  });

  test("re-running produces byte-identical output", () => {
    const before = readFileSync(agentsFile);
    const addBefore = readFileSync(join(promptsDir, "add.md"));
    const res = codexEmitter.emit([add, audit], root);
    expect(res.written).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(readFileSync(agentsFile).equals(before)).toBe(true);
    expect(readFileSync(join(promptsDir, "add.md")).equals(addBefore)).toBe(true);
  });

  test("dropping a skill prunes its prompt and index row", () => {
    const res = codexEmitter.emit([add], root);
    expect(res.removed).toEqual([".codex/prompts/audit.md"]);
    expect(existsSync(join(promptsDir, "audit.md"))).toBe(false);
    const text = readFileSync(agentsFile, "utf8");
    expect(text).toContain("- **add**");
    expect(text).not.toContain("- **audit**");
  });
});

describe("index block preserves surrounding content", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note.");
  const agentsFile = join(root, "AGENTS.md");
  const preamble = "# My Repo\n\nHand-written guidance the emitter must never touch.\n";

  test("appends the block below existing content", () => {
    writeFileSync(agentsFile, preamble);
    codexEmitter.emit([add], root);
    const text = readFileSync(agentsFile, "utf8");
    expect(text.startsWith(preamble)).toBe(true);
    expect(text).toContain(INDEX_START);
  });

  test("re-run stays idempotent with the preamble intact", () => {
    const before = readFileSync(agentsFile);
    codexEmitter.emit([add], root);
    expect(readFileSync(agentsFile).equals(before)).toBe(true);
  });
});

describe("geminiEmitter GEMINI.md index", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note.");
  const geminiFile = join(root, "GEMINI.md");

  test("creates the block then is idempotent", () => {
    const first = geminiEmitter.emit([add], root);
    expect(first.written).toEqual(["GEMINI.md"]);
    const bytes = readFileSync(geminiFile);
    expect(readFileSync(geminiFile, "utf8")).toContain("- **add**");

    const second = geminiEmitter.emit([add], root);
    expect(second.written).toEqual([]);
    expect(readFileSync(geminiFile).equals(bytes)).toBe(true);
  });
});
