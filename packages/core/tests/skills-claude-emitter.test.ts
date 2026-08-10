import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeEmitter } from "../src/lib/skills/emitters/claude";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "bf-claude-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Create a real skill dir under `.agents/skills` and return its manifest. */
function skill(root: string, name: string): SkillManifest {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`);
  return { name, description: `${name} skill`, dir, source: "core", frontmatter: {} };
}

describe("claudeEmitter symlink round-trip", () => {
  const root = mkRepo();
  const one = skill(root, "one");
  const two = skill(root, "two");
  const claudeDir = join(root, ".claude", "skills");

  test("first emit creates relative symlinks", () => {
    const res = claudeEmitter.emit([one, two], root);
    expect(res.written.sort()).toEqual([".claude/skills/one", ".claude/skills/two"]);
    expect(res.removed).toEqual([]);
    for (const name of ["one", "two"]) {
      const link = join(claudeDir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
    }
  });

  test("second emit is idempotent (no writes, no removals)", () => {
    const res = claudeEmitter.emit([one, two], root);
    expect(res.written).toEqual([]);
    expect(res.removed).toEqual([]);
  });

  test("dropping a skill prunes its stale symlink", () => {
    const res = claudeEmitter.emit([one], root);
    expect(res.removed).toEqual([".claude/skills/two"]);
    expect(existsSync(join(claudeDir, "two"))).toBe(false);
    expect(lstatSync(join(claudeDir, "one")).isSymbolicLink()).toBe(true);
  });
});

describe("claudeEmitter never clobbers real entries", () => {
  const root = mkRepo();
  const one = skill(root, "one");
  const claudeDir = join(root, ".claude", "skills");
  mkdirSync(claudeDir, { recursive: true });

  test("a real dir where a link would go is left untouched", () => {
    const real = join(claudeDir, "handmade");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "note.txt"), "keep me");
    // "handmade" is not in the skill set → prune must skip it (not a symlink).
    const res = claudeEmitter.emit([one], root);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(real, "note.txt"))).toBe(true);
  });

  test("a real file at a skill's target path is not overwritten", () => {
    const clash = skill(root, "clash");
    const filePath = join(claudeDir, "clash");
    writeFileSync(filePath, "i am a file");
    const res = claudeEmitter.emit([one, clash], root);
    expect(res.written).not.toContain(".claude/skills/clash");
    expect(lstatSync(filePath).isFile()).toBe(true);
  });
});
