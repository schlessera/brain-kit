import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildTaxonomy } from "@schlessera/brain/internal";
import { discoverSkills } from "../../core/src/lib/skills/discover.js";
import { lintSkills } from "../../core/src/lib/skills/lint.js";
import type { LoadedModule } from "@schlessera/brain";
import manifest, { configSchema } from "../src/module";

// Two-phase manifest: the contribution comes out of setup(validatedConfig).
const cfg = configSchema.parse({ criteria: "career/opportunities/search-criteria.md" });
const contribution = manifest.setup(cfg);

const loaded: LoadedModule = {
  key: "@schlessera/brain-module-jobs",
  manifest: { name: manifest.name, ...contribution },
  dir: resolve(import.meta.dir, ".."),
  config: cfg,
};

describe("module manifest", () => {
  test("declares the jobs command, opportunity type, anchor, and cron", () => {
    expect(manifest.name).toBe("jobs");
    expect(contribution.taxonomy?.types?.opportunity?.dir).toBe("career/opportunities");
    expect(contribution.commands).toHaveProperty("jobs");
    expect(contribution.indexRules?.dirAnchors).toContain("status.md");
    // Scheduling follows ordinary configured board selection.
    expect(contribution.cron?.[0]?.command).toBe("jobs scrape");
  });

  test("setup shapes the opportunity dir from config", () => {
    const custom = manifest.setup(
      configSchema.parse({ criteria: "c.md", opportunitiesDir: "work/pipeline" })
    );
    expect(custom.taxonomy?.types?.opportunity?.dir).toBe("work/pipeline");
  });

  test("configSchema requires criteria and fills defaults", () => {
    const cfg = configSchema.parse({ criteria: "career/opportunities/search-criteria.md" });
    expect(cfg.opportunitiesDir).toBe("career/opportunities");
    expect(cfg.boards).toEqual(["remoteok", "weworkremotely", "workingnomads", "remotelyde"]);
    expect(cfg.queries.length).toBeGreaterThan(0);
    expect(() => configSchema.parse({})).toThrow(); // criteria is required
  });
});

describe("taxonomy roundtrip", () => {
  test("typeForPath(dirForType('opportunity') + '/x.md') === 'opportunity'", () => {
    const tax = buildTaxonomy({ modules: [loaded] });
    const dir = tax.dirForType("opportunity");
    expect(dir).toBe("career/opportunities");
    expect(tax.typeForPath(`${dir}/x.md`)).toBe("opportunity");
  });
});

describe("bundled skills", () => {
  test("the manifest points at the skills dir and all three are discoverable", () => {
    expect(contribution.skills).toBe("./skills");

    const { skills, warnings } = discoverSkills(
      { root: resolve(import.meta.dir, "fixtures"), modules: [loaded] },
      { coreSkillsDir: resolve(import.meta.dir, "no-such-core-skills") }
    );
    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.name).sort()).toEqual([
      "interview-scheduled",
      "jobs-review",
      "research-opportunity",
    ]);
    for (const skill of skills) expect(skill.source).toBe("module");
  });

  test("the skills pass the lint rules", () => {
    const { skills } = discoverSkills(
      { root: resolve(import.meta.dir, "fixtures"), modules: [loaded] },
      { coreSkillsDir: resolve(import.meta.dir, "no-such-core-skills") }
    );
    // Warnings too, not just errors: an undeclared shell command or an absolute
    // path in a skill we ship is a portability defect, not a style preference.
    expect(skills.length, "jobs skills reach the lint assertions").toBeGreaterThan(0);
    const findings = lintSkills(skills).filter((f) => f.severity !== "info");
    expect(findings).toEqual([]);
  });

  test("the skills describe when to use them, not what they do", () => {
    // The description is the triggering mechanism; mechanism belongs in the
    // body. Leading with "Use ..." keeps that discipline visible.
    const { skills } = discoverSkills(
      { root: resolve(import.meta.dir, "fixtures"), modules: [loaded] },
      { coreSkillsDir: resolve(import.meta.dir, "no-such-core-skills") }
    );
    expect(skills.length, "jobs skills reach the description assertions").toBeGreaterThan(0);
    const offenders = skills
      .filter((s) => !s.description.startsWith("Use "))
      .map((s) => s.name);
    expect(offenders).toEqual([]);
  });

  test("no personal specifics leaked in from the source brain", () => {
    // The reference implementations named a real person, real CV variants, and
    // a real opportunity slug used as an example prep file. Those are exactly
    // what the genericization had to strip. The owner's first name is spelled
    // in pieces so this assertion does not itself trip the CI leakage gate.
    const ownerName = new RegExp(`\\b${"Al" + "ain"}\\b`, "i");
    const dir = resolve(import.meta.dir, "..", "skills");
    for (const name of ["jobs-review", "research-opportunity", "interview-scheduled"]) {
      const body = readFileSync(resolve(dir, name, "SKILL.md"), "utf8");
      expect(body).not.toMatch(ownerName);
      expect(body).not.toMatch(/cv-ai-(protocols|pm)/);
      expect(body).not.toMatch(/opportunities\/a-team/);
      // The opportunity type, not the pre-module `type: career`.
      expect(body).not.toMatch(/type: career/);
    }
  });
});
