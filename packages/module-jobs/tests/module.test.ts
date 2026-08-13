import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildTaxonomy, discoverSkills, lintSkills } from "@schlessera/brain";
import type { LoadedModule } from "@schlessera/brain";
import manifest, { configSchema } from "../src/module";
import { SOURCES } from "../src/types";

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
    // --browser is additive, so the scheduled run covers the API boards AND
    // the headless-Chrome ones in a single pass.
    expect(contribution.cron?.[0]?.command).toBe("jobs scrape --all --browser");
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
    expect(cfg.queries.length).toBeGreaterThan(0);
    expect(() => configSchema.parse({})).toThrow(); // criteria is required
  });

  test("boards default tracks SOURCES rather than a literal of its own", () => {
    // cmdScrape treats a non-empty configured `boards` as authoritative, so a
    // hardcoded default here would silently shadow SOURCES and leave the other
    // boards unscraped on a default install.
    const cfg = configSchema.parse({ criteria: "career/opportunities/search-criteria.md" });
    expect(cfg.boards).toEqual([...SOURCES]);
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
    const blocking = lintSkills(skills).filter((f) => f.severity === "error");
    expect(blocking).toEqual([]);
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
