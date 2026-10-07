import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { type LoadedModule } from "@schlessera/brain";
import { buildTaxonomy } from "@schlessera/brain/internal";
import { discoverSkills } from "../../core/src/lib/skills/discover.js";
import { lintSkills } from "../../core/src/lib/skills/lint.js";

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
  it("declares only talk/conference types with their dirs", () => {
    const types = contribution.taxonomy?.types ?? {};
    expect(types.talk?.dir).toBe("talks");
    expect(types.conference?.dir).toBe("conferences");
    expect(Object.keys(types).sort()).toEqual(["conference", "talk"]);
  });

  it("contributes conference hints while travel owns its hints", () => {
    const hints = contribution.taxonomy?.classifierHints ?? {};
    expect(hints.conference).toContain("call for papers");
    expect(hints.travel).toBeUndefined();
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
        { name: "Odysseus", role: "partner" },
        { name: "Penelope", role: "partner", requirementsDoc: "people/penelope.md" },
      ],
    });
    expect(parsed.travelParty).toHaveLength(2);
    expect(parsed.travelParty[1]).toEqual({
      name: "Penelope",
      role: "partner",
      requirementsDoc: "people/penelope.md",
    });
  });

  it("rejects unknown keys", () => {
    expect(() => configSchema.parse({ nope: true })).toThrow();
  });
});

describe("speaking taxonomy roundtrip", () => {
  const taxonomy = buildTaxonomy({ modules: [loaded()] });

  it("resolves each contributed type's dir back to the type", () => {
    for (const type of ["talk", "conference"]) {
      const dir = taxonomy.dirForType(type);
      expect(dir).not.toBeNull();
      expect(taxonomy.typeForPath(`${dir}/x.md`)).toBe(type);
    }
  });

  it("classifies conference vocabulary", () => {
    expect(taxonomy.classify("submission deadline for the keynote")).toBe("conference");
  });

  it("does not contribute the moved travel type", () => {
    expect(taxonomy.validTypes()).not.toContain("travel");
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
    expect(skills.length, "speaking skills reach the lint and description checks").toBeGreaterThan(0);
    return skills;
  }

  it("ships the seven speaking skills", () => {
    expect(skills().map((s) => s.name).sort()).toEqual([
      "brainstorm-talks",
      "conference-aftermath",
      "conference-research",
      "new-submission",
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
