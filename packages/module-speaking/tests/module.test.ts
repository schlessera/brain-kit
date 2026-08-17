import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildTaxonomy, discoverSkills, lintSkills, type LoadedModule } from "@schlessera/brain";

import manifest, { configSchema } from "../src/module";

// Two-phase manifest: the contribution comes out of setup(validatedConfig).
const contribution = manifest.setup(configSchema.parse({}));

function loaded(): LoadedModule {
  return {
    key: "@schlessera/brain-module-speaking",
    manifest: { name: manifest.name, ...contribution },
    dir: import.meta.dir,
    config: {},
  };
}

describe("speaking manifest", () => {
  it("declares talk/conference/travel types with their dirs", () => {
    const types = contribution.taxonomy?.types ?? {};
    expect(types.talk?.dir).toBe("talks");
    expect(types.conference?.dir).toBe("conferences");
    expect(types.travel?.dir).toBe("travel");
  });

  it("contributes classifier hints for conference and travel", () => {
    const hints = contribution.taxonomy?.classifierHints ?? {};
    expect(hints.conference).toContain("call for papers");
    expect(hints.travel).toContain("itinerary");
  });

  it("contributes the conference/travel/talk dir anchors", () => {
    expect(contribution.indexRules?.dirAnchors).toEqual([
      "status.md",
      "itinerary.md",
      "outline.md",
    ]);
  });

  it("excludes slide-deck working segments", () => {
    const segments = contribution.exclude?.segments ?? [];
    expect(segments).toContain("alt-decks");
    expect(segments).toContain("versions");
    expect(segments).toContain("deck");
  });
});

describe("speaking configSchema", () => {
  it("defaults travelParty to an empty array", () => {
    expect(configSchema.parse({})).toEqual({ travelParty: [] });
  });

  it("parses a travel party with roles and requirement docs", () => {
    const parsed = configSchema.parse({
      travelParty: [
        { name: "Alex Example", role: "partner" },
        { name: "Rover", role: "assistance-dog", requirementsDoc: "me/family/rover.md" },
      ],
    });
    expect(parsed.travelParty).toHaveLength(2);
    expect(parsed.travelParty[1]).toEqual({
      name: "Rover",
      role: "assistance-dog",
      requirementsDoc: "me/family/rover.md",
    });
  });

  it("rejects unknown keys", () => {
    expect(() => configSchema.parse({ nope: true })).toThrow();
  });
});

describe("speaking taxonomy roundtrip", () => {
  const taxonomy = buildTaxonomy({ modules: [loaded()] });

  it("resolves each contributed type's dir back to the type", () => {
    for (const type of ["talk", "conference", "travel"]) {
      const dir = taxonomy.dirForType(type);
      expect(dir).not.toBeNull();
      expect(taxonomy.typeForPath(`${dir}/x.md`)).toBe(type);
    }
  });

  it("classifies conference vocabulary", () => {
    expect(taxonomy.classify("submission deadline for the keynote")).toBe("conference");
  });

  it("classifies travel vocabulary", () => {
    expect(taxonomy.classify("flight and hotel booking confirmed")).toBe("travel");
  });
});

describe("shipped skills", () => {
  // The module's skills reach a user's repo verbatim, so hold them to the same
  // bar as the core ones: no Claude-only tool references outside an
  // `<!-- agent:claude -->` region, no undeclared shell commands, no absolute
  // paths, and a frontmatter name matching the directory.
  const forSkills: LoadedModule = {
    key: "@schlessera/brain-module-speaking",
    manifest: { name: manifest.name, ...contribution },
    dir: resolve(import.meta.dir, ".."),
    config: {},
  };

  function skills() {
    const { skills, warnings } = discoverSkills(
      { root: mkdtempSync(join(tmpdir(), "brain-speaking-skills-")), modules: [forSkills] },
      { coreSkillsDir: resolve(import.meta.dir, "no-such-core-skills") }
    );
    expect(warnings).toEqual([]);
    return skills;
  }

  it("ships the eight speaking skills", () => {
    expect(skills().map((s) => s.name).sort()).toEqual([
      "brainstorm-talks",
      "conference-aftermath",
      "conference-research",
      "new-submission",
      "plan-travel",
      "submission-outcome",
      "talk-ideas",
      "talk-prep",
    ]);
  });

  it("passes the lint rules with no errors or warnings", () => {
    const findings = lintSkills(skills()).filter((f) => f.severity !== "info");
    expect(findings).toEqual([]);
  });

  it("describes when to use each skill, not what it does", () => {
    // The description is the triggering mechanism; mechanism belongs in the
    // body. Leading with "Use ..." keeps that discipline visible.
    const offenders = skills()
      .filter((s) => !s.description.startsWith("Use "))
      .map((s) => s.name);
    expect(offenders).toEqual([]);
  });
});
