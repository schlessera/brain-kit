import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { discoverSkills } from "../src/lib/skills/discover";
import type { LoadedModule } from "../src/lib/module-types";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Write `<baseDir>/<dirName>/SKILL.md`. Pass `fields: null` for no frontmatter. */
function writeSkill(baseDir: string, dirName: string, fields: Record<string, string> | null): string {
  const dir = join(baseDir, dirName);
  mkdirSync(dir, { recursive: true });
  const content = fields
    ? `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# ${dirName}\n\nBody.\n`
    : `# ${dirName}\n\nNo frontmatter here.\n`;
  writeFileSync(join(dir, "SKILL.md"), content);
  return dir;
}

function fakeModule(dir: string, name: string): LoadedModule {
  return { key: `@schlessera/brain-module-${name}`, dir, config: {}, manifest: { name, skills: "skills" } };
}

function byName(skills: SkillManifest[]): Record<string, SkillManifest> {
  return Object.fromEntries(skills.map((s) => [s.name, s]));
}

describe("discoverSkills precedence", () => {
  const coreDir = mkTmp("bf-core-");
  writeSkill(coreDir, "alpha", { name: "alpha", description: "core alpha" });
  writeSkill(coreDir, "shared", { name: "shared", description: "core shared" });
  writeSkill(coreDir, "both", { name: "both", description: "core both" });
  writeSkill(coreDir, "broken", null); // no frontmatter → warning + skip
  writeSkill(coreDir, "nodesc", { name: "nodesc" }); // missing description → warning + skip

  const modDir = mkTmp("bf-mod-");
  const modSkills = join(modDir, "skills");
  writeSkill(modSkills, "beta", { name: "beta", description: "module beta" });
  writeSkill(modSkills, "shared", { name: "shared", description: "module shared" });
  writeSkill(modSkills, "both", { name: "both", description: "module both" });

  const root = mkTmp("bf-root-");
  const localSkills = join(root, ".agents", "skills");
  writeSkill(localSkills, "localonly", { name: "localonly", description: "local only" });
  writeSkill(localSkills, "shared", { name: "shared", description: "local shared" });
  writeSkill(localSkills, "both", { name: "both", description: "local both" });

  const { skills, warnings } = discoverSkills(
    { root, modules: [fakeModule(modDir, "sample")] },
    { coreSkillsDir: coreDir }
  );
  const map = byName(skills);

  test("collects one manifest per unique name", () => {
    expect(Object.keys(map).sort()).toEqual(["alpha", "beta", "both", "localonly", "shared"]);
  });

  test("local wins over module wins over core", () => {
    expect(map.shared.source).toBe("local");
    expect(map.shared.description).toBe("local shared");
    expect(map.both.source).toBe("local");
  });

  test("module overrides core; core-only and module-only survive", () => {
    expect(map.alpha.source).toBe("core");
    expect(map.beta.source).toBe("module");
    expect(map.localonly.source).toBe("local");
  });

  test("dir is the skill's own directory", () => {
    expect(map.alpha.dir).toBe(join(coreDir, "alpha"));
    expect(map.beta.dir).toBe(join(modSkills, "beta"));
    expect(map.localonly.dir).toBe(join(localSkills, "localonly"));
  });

  test("invalid/missing frontmatter is warned and skipped", () => {
    expect(map.broken).toBeUndefined();
    expect(map.nodesc).toBeUndefined();
    expect(warnings.some((w) => w.includes("broken/SKILL.md"))).toBe(true);
    expect(warnings.some((w) => w.includes("nodesc/SKILL.md"))).toBe(true);
  });
});

describe("discoverSkills edge cases", () => {
  test("module-vs-module collision keeps the first and warns", () => {
    const modA = mkTmp("bf-modA-");
    writeSkill(join(modA, "skills"), "dup", { name: "dup", description: "from A" });
    const modB = mkTmp("bf-modB-");
    writeSkill(join(modB, "skills"), "dup", { name: "dup", description: "from B" });
    const root = mkTmp("bf-root2-");

    const { skills, warnings } = discoverSkills(
      { root, modules: [fakeModule(modA, "a"), fakeModule(modB, "b")] },
      { coreSkillsDir: mkTmp("bf-emptycore-") }
    );
    expect(byName(skills).dup.description).toBe("from A");
    expect(warnings.some((w) => w.includes("more than one module"))).toBe(true);
  });

  test("symlinked entries under .agents/skills are not read as local skills", () => {
    const coreDir = mkTmp("bf-core3-");
    const realCore = writeSkill(coreDir, "materialized", {
      name: "materialized",
      description: "a core skill",
    });
    const root = mkTmp("bf-root3-");
    const localSkills = join(root, ".agents", "skills");
    mkdirSync(localSkills, { recursive: true });
    // Simulate a materialized package skill: a symlink in .agents/skills.
    symlinkSync(realCore, join(localSkills, "materialized"), "dir");

    const { skills } = discoverSkills({ root, modules: [] }, { coreSkillsDir: coreDir });
    const m = byName(skills).materialized;
    // Present from the CORE layer, not misread as a local skill.
    expect(m.source).toBe("core");
    expect(m.dir).toBe(realCore);
  });

  test("missing dirs yield no skills and no throw", () => {
    const { skills, warnings } = discoverSkills(
      { root: mkTmp("bf-empty-"), modules: [] },
      { coreSkillsDir: join(tmpdir(), "definitely-not-here-xyz") }
    );
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
