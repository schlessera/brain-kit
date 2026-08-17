import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { piEmitter } from "../src/lib/skills/emitters/pi";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "bf-pi-"));
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

describe("piEmitter symlink round-trip", () => {
  const root = mkRepo();
  const one = skill(root, "one");
  const two = skill(root, "two");
  const piDir = join(root, ".pi", "skills");

  test("first emit creates relative symlinks into the canonical home", () => {
    // pi reads <cwd>/.pi/skills, never .agents/skills — but the skill itself
    // must stay single-sourced, so these are links rather than copies.
    const res = piEmitter.emit([one, two], root);
    expect(res.written.sort()).toEqual([".pi/skills/one", ".pi/skills/two"]);
    expect(res.removed).toEqual([]);
    for (const name of ["one", "two"]) {
      const link = join(piDir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
    }
  });

  test("second emit is idempotent (no writes, no removals)", () => {
    const res = piEmitter.emit([one, two], root);
    expect(res.written).toEqual([]);
    expect(res.removed).toEqual([]);
  });

  test("dropping a skill prunes its stale symlink", () => {
    const res = piEmitter.emit([one], root);
    expect(res.removed).toEqual([".pi/skills/two"]);
    expect(existsSync(join(piDir, "two"))).toBe(false);
    expect(lstatSync(join(piDir, "one")).isSymbolicLink()).toBe(true);
  });
});

describe("piEmitter never clobbers real entries", () => {
  const root = mkRepo();
  const one = skill(root, "one");
  const piDir = join(root, ".pi", "skills");
  mkdirSync(piDir, { recursive: true });

  test("a hand-written skill directory is left untouched", () => {
    const real = join(piDir, "handmade");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "note.txt"), "keep me");
    const res = piEmitter.emit([one], root);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(real, "note.txt"))).toBe(true);
  });

  test("a real file at a skill's target path is not overwritten", () => {
    const clash = skill(root, "clash");
    const filePath = join(piDir, "clash");
    writeFileSync(filePath, "i am a file");
    const res = piEmitter.emit([one, clash], root);
    expect(res.written).not.toContain(".pi/skills/clash");
    expect(lstatSync(filePath).isFile()).toBe(true);
  });
});
