/**
 * CI gate for the skills this package ships.
 *
 * `lintSkills` had unit coverage for each rule and module-jobs asserted its own
 * skills were clean, but nothing checked the twelve-plus core skills — they were
 * clean by author discipline alone. This closes that: a core skill that
 * references a Claude-only tool outside an `<!-- agent:claude -->` region, drops
 * its `name`, or renames its directory now fails the build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { discoverSkills } from "../src/lib/skills/discover";
import { lintSkills } from "../src/lib/skills/lint";

const CORE_SKILLS_DIR = resolve(import.meta.dir, "..", "skills");

let emptyRoot: string;

beforeAll(() => {
  // An empty root so the repo-local layer contributes nothing: this asserts on
  // the shipped skills only, never on whatever the developer has in their brain.
  emptyRoot = mkdtempSync(join(tmpdir(), "brain-skills-lint-"));
});

afterAll(() => rmSync(emptyRoot, { recursive: true, force: true }));

function shippedSkills() {
  const { skills, warnings } = discoverSkills(
    { root: emptyRoot, modules: [] },
    { coreSkillsDir: CORE_SKILLS_DIR }
  );
  return { skills, warnings };
}

describe("shipped core skills", () => {
  test("are discovered", () => {
    const { skills, warnings } = shippedSkills();
    expect(warnings).toEqual([]);
    expect(skills.length).toBeGreaterThanOrEqual(12);
    expect(skills.every((s) => s.source === "core")).toBe(true);
  });

  test("produce no lint errors", () => {
    const { skills } = shippedSkills();
    const blocking = lintSkills(skills).filter((f) => f.severity === "error");
    expect(blocking).toEqual([]);
  });

  test("have trigger-first descriptions", () => {
    // The description is the whole triggering mechanism — it is all the model
    // sees when deciding whether a skill is relevant. So it must describe the
    // SITUATION that should pull the skill in, not what the skill does or how
    // it works; the body is where mechanism belongs. Leading with "Use ..."
    // is a crude but effective proxy for having written it from that angle.
    const { skills } = shippedSkills();
    const offenders = skills
      .filter((s) => !s.description.startsWith("Use "))
      .map((s) => s.name);
    expect(offenders).toEqual([]);
  });

  test("have descriptions within the spec's length cap", () => {
    const { skills } = shippedSkills();
    const tooLong = skills.filter((s) => s.description.length > 1024).map((s) => s.name);
    expect(tooLong).toEqual([]);
  });

  test("produce no lint warnings", () => {
    // Warnings are undeclared shell commands and absolute paths. Both are real
    // portability defects in a skill we ship, so hold them at zero too — the
    // fix is a `requires:` entry or a repo-relative path, never a suppression.
    const { skills } = shippedSkills();
    const warnings = lintSkills(skills).filter((f) => f.severity === "warning");
    expect(warnings).toEqual([]);
  });
});
