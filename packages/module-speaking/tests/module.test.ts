import { describe, expect, it } from "bun:test";
import { buildTaxonomy, type LoadedModule } from "@brainform/core";

import manifest, { configSchema } from "../src/module";

function loaded(): LoadedModule {
  return {
    key: "@brainform/module-speaking",
    manifest,
    dir: import.meta.dir,
    config: {},
  };
}

describe("speaking manifest", () => {
  it("declares talk/conference/travel types with their dirs", () => {
    const types = manifest.taxonomy?.types ?? {};
    expect(types.talk?.dir).toBe("talks");
    expect(types.conference?.dir).toBe("conferences");
    expect(types.travel?.dir).toBe("travel");
  });

  it("contributes classifier hints for conference and travel", () => {
    const hints = manifest.taxonomy?.classifierHints ?? {};
    expect(hints.conference).toContain("call for papers");
    expect(hints.travel).toContain("itinerary");
  });

  it("contributes the conference/travel/talk dir anchors", () => {
    expect(manifest.indexRules?.dirAnchors).toEqual([
      "status.md",
      "itinerary.md",
      "outline.md",
    ]);
  });

  it("excludes slide-deck working segments", () => {
    const segments = manifest.exclude?.segments ?? [];
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
