/**
 * Every skill a package ships lints clean at warning level: no errors, no
 * warnings. `packages/core/tests/skills-shipped-lint.test.ts` holds core's
 * skills to errors only; this covers every package's skills and the warning
 * rules too, such as a description that says manual-only without the flag.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import matter from "gray-matter";

import { lintSkills } from "../packages/core/src/lib/skills/lint";
import type { SkillManifest } from "../packages/core/src/lib/seams";

const ROOT = resolve(import.meta.dir, "..");

test("every shipped skill lints without errors or warnings", () => {
  const skills: SkillManifest[] = [...new Bun.Glob("packages/*/skills/*/SKILL.md").scanSync({ cwd: ROOT })]
    .sort()
    .map((rel) => {
      const data = matter(readFileSync(resolve(ROOT, rel), "utf8")).data as Record<string, unknown>;
      return {
        name: String(data.name ?? ""),
        description: String(data.description ?? ""),
        dir: resolve(ROOT, dirname(rel)),
        source: "core",
        frontmatter: data,
      };
    });
  expect(skills.length).toBeGreaterThan(20);
  const findings = lintSkills(skills)
    .filter((f) => f.severity !== "info")
    .map((f) => `${relative(ROOT, skills.find((s) => s.name === f.skill)?.dir ?? "")}: ${f.rule}: ${f.message}`);
  expect(findings).toEqual([]);
});
