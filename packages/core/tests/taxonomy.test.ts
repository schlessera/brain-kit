import { describe, expect, test } from "bun:test";

import { brainConfigSchema, type BrainConfig } from "../src/lib/config";
import type { LoadedModule } from "../src/lib/module-types";
import { buildTaxonomy } from "../src/lib/taxonomy";

/** A speaking-like module used across tests. */
function speakingModule(): LoadedModule {
  return {
    key: "@brainform/module-speaking",
    dir: "/tmp/fake",
    config: {},
    manifest: {
      name: "speaking",
      taxonomy: {
        types: {
          talk: { dir: "talks" },
          conference: { dir: "conferences" },
          travel: { dir: "travel" },
        },
        classifierHints: {
          conference: ["cfp", "call for papers", "keynote", "conference", "submission deadline", "speaker slot"],
          travel: ["itinerary", "flight", "hotel booking", "accommodation", "road trip", "check-in", "train to"],
        },
        assetTitleRules: [
          { pattern: "talks/*/slides/**", label: "Slide", slugFrom: 1 },
          { prefix: "talks/", label: "Talk Asset" },
        ],
      },
      indexRules: { dirAnchors: ["status.md", "itinerary.md", "outline.md"] },
      exclude: { segments: ["alt-decks", "versions", "deck"] },
    },
  };
}

/** A user config in the shape the reference brain uses. */
function referenceUserConfig(): BrainConfig {
  return brainConfigSchema.parse({
    taxonomy: {
      types: {
        career: { dir: "career" },
        expertise: { dir: "expertise" },
        project: {
          dir: "projects/active",
          match: ["projects/"],
          staleDays: 90,
          staleSeverity: "warning",
          appendMatch: true,
        },
        network: { dir: "network", appendMatch: true },
        opinion: { dir: "opinions" },
        strategy: { dir: "content-strategy", orphanExempt: true },
        infrastructure: { dir: "infrastructure", match: ["infrastructure/", "home/"] },
      },
      classifierHints: {
        opinion: ["i think", "i believe", "my position", "my stance", "should", "must"],
      },
      propagation: [{ source: "me/bios/FACTS.md", derivatives: "me/bios/*.md" }],
      assetTitleRules: [
        { prefix: "me/media-kit/photography", label: "Photography" },
        { prefix: "me/media-kit", label: "Media Kit" },
        { prefix: "career/", label: "CV" },
      ],
    },
  });
}

describe("core defaults (no config)", () => {
  const tax = buildTaxonomy({});

  test("core types exist", () => {
    expect(tax.validTypes().sort()).toEqual(["context", "identity", "index", "note"]);
  });

  test("typeForPath falls back to inbox type", () => {
    expect(tax.typeForPath("random/thing.png")).toBe("note");
    expect(tax.typeForPath("me/photo.png")).toBe("identity");
  });

  test("index type skips dir checks", () => {
    expect(tax.expectedPrefixesFor("index")).toBeNull();
    expect(tax.dirForType("index")).toBeNull();
  });

  test("staleness: context 30/warning, default 180/info", () => {
    expect(tax.stalenessFor("context/current-focus.md")).toEqual({ days: 30, severity: "warning" });
    expect(tax.stalenessFor("me/identity.md")).toEqual({ days: 180, severity: "info" });
  });

  test("default canonical + dir anchors", () => {
    expect(tax.canonicalPath("identity")).toBe("me/identity.md");
    expect(tax.canonicalPath("currentFocus")).toBe("context/current-focus.md");
    expect(tax.dirAnchors).toEqual(["_index.md"]);
  });

  test("default exclusions", () => {
    expect(tax.isExcludedPath("CLAUDE.md")).toBe(true);
    expect(tax.isExcludedPath("node_modules/x/y.md")).toBe(true);
    expect(tax.isExcludedPath("me/notes.md")).toBe(false);
  });
});

describe("reference brain shape (modules + user config)", () => {
  const tax = buildTaxonomy({ user: referenceUserConfig(), modules: [speakingModule()] });

  test("reproduces historical inferAssetType", () => {
    expect(tax.typeForPath("me/media-kit/photo.jpg")).toBe("identity");
    expect(tax.typeForPath("talks/the-stack/slides/01.png")).toBe("talk");
    expect(tax.typeForPath("career/cv.pdf")).toBe("career");
    expect(tax.typeForPath("projects/active/x/status.md")).toBe("project");
    expect(tax.typeForPath("conferences/fooconf/notes.md")).toBe("conference");
    expect(tax.typeForPath("home/router.md")).toBe("infrastructure");
    expect(tax.typeForPath("infrastructure/vps.md")).toBe("infrastructure");
    expect(tax.typeForPath("downloads/random.pdf")).toBe("note");
  });

  test("longest prefix wins for nested type dirs", () => {
    const withJobs = buildTaxonomy({
      user: referenceUserConfig(),
      modules: [
        speakingModule(),
        {
          key: "@brainform/module-jobs",
          dir: "/tmp/fake2",
          config: {},
          manifest: {
            name: "jobs",
            taxonomy: { types: { opportunity: { dir: "career/opportunities" } } },
          },
        },
      ],
    });
    expect(withJobs.typeForPath("career/opportunities/acme/status.md")).toBe("opportunity");
    expect(withJobs.typeForPath("career/cv.md")).toBe("career");
  });

  test("reproduces historical staleness rules", () => {
    expect(tax.stalenessFor("projects/active/x.md")).toEqual({ days: 90, severity: "warning" });
    expect(tax.stalenessFor("projects/archive/y.md")).toEqual({ days: 180, severity: "info" });
    expect(tax.stalenessFor("context/now.md")).toEqual({ days: 30, severity: "warning" });
  });

  test("type-mismatch prefixes honour match lists", () => {
    expect(tax.expectedPrefixesFor("project")).toEqual(["projects/"]);
    expect(tax.expectedPrefixesFor("infrastructure")).toEqual(["infrastructure/", "home/"]);
  });

  test("reproduces historical deriveAssetTitle", () => {
    expect(tax.assetTitleFor("me/media-kit/photography/head.jpg")).toBe("Photography: head");
    expect(tax.assetTitleFor("me/media-kit/one-pager.pdf")).toBe("Media Kit: one-pager");
    expect(tax.assetTitleFor("talks/woodworking-basics/slides/05.png")).toBe(
      "Slide: 05 (woodworking-basics)"
    );
    expect(tax.assetTitleFor("talks/woodworking-basics/poster.pdf")).toBe("Talk Asset: poster");
    // Prefix rules match the containing dir: nested files match "career/",
    // a direct child of career/ falls through to the generic dir label
    // (verbatim historical deriveAssetTitle semantics).
    expect(tax.assetTitleFor("career/applications/acme/jd.pdf")).toBe("CV: jd");
    expect(tax.assetTitleFor("career/cv-2026.pdf")).toBe("career: cv-2026");
    expect(tax.assetTitleFor("notes/scans/receipt.pdf")).toBe("scans: receipt");
  });

  test("classifier order: modules → user → core", () => {
    expect(tax.classify("The CFP closes Friday")).toBe("conference");
    expect(tax.classify("booked the flight and hotel booking")).toBe("travel");
    expect(tax.classify("I think this pattern is wrong")).toBe("opinion");
    expect(tax.classify("what matters right now")).toBe("context");
    expect(tax.classify("plain shopping list")).toBeNull();
  });

  test("module dir anchors + exclude segments merge", () => {
    expect(tax.dirAnchors).toEqual(["_index.md", "status.md", "itinerary.md", "outline.md"]);
    expect(tax.isExcludedPath("talks/foo/alt-decks/v1.md")).toBe(true);
    expect(tax.isExcludedPath("talks/foo/deck/build.png")).toBe(true);
  });

  test("append-match + orphan-exempt flags", () => {
    expect(tax.appendMatchTypes()).toEqual(["project", "network"]);
    expect(tax.isOrphanExempt("index")).toBe(true);
    expect(tax.isOrphanExempt("context")).toBe(true);
    expect(tax.isOrphanExempt("strategy")).toBe(true);
    expect(tax.isOrphanExempt("career")).toBe(false);
  });

  test("propagation rules pass through", () => {
    expect(tax.propagation).toEqual([
      { source: "me/bios/FACTS.md", derivatives: "me/bios/*.md" },
    ]);
  });
});

describe("collisions and overrides", () => {
  test("module redefining a core type throws", () => {
    expect(() =>
      buildTaxonomy({
        modules: [
          {
            key: "x",
            dir: "/tmp",
            config: {},
            manifest: { name: "x", taxonomy: { types: { identity: { dir: "people" } } } },
          },
        ],
      })
    ).toThrow(/collision/);
  });

  test("two types claiming the identical prefix throws", () => {
    expect(() =>
      buildTaxonomy({
        user: brainConfigSchema.parse({
          taxonomy: {
            types: {
              alpha: { dir: "shared" },
              beta: { dir: "shared" },
            },
          },
        }),
      })
    ).toThrow(/prefix/);
  });

  test("user may override a core type", () => {
    const tax = buildTaxonomy({
      user: brainConfigSchema.parse({
        taxonomy: { types: { note: { dir: "inbox", inbox: true } } },
      }),
    });
    expect(tax.dirForType("note")).toBe("inbox");
    expect(tax.typeForPath("inbox/x.md")).toBe("note");
  });

  test("removing every inbox type throws", () => {
    expect(() =>
      buildTaxonomy({
        user: brainConfigSchema.parse({
          taxonomy: { types: { note: { dir: "notes", inbox: false } } },
        }),
      })
    ).toThrow(/inbox/);
  });

  test("canonical entry can be disabled with empty string", () => {
    const tax = buildTaxonomy({
      user: brainConfigSchema.parse({ taxonomy: { canonical: { currentFocus: "" } } }),
    });
    expect(tax.canonicalPath("currentFocus")).toBeNull();
    expect(tax.canonicalPath("identity")).toBe("me/identity.md");
  });

  test("classifierHints for unknown type throws", () => {
    expect(() =>
      buildTaxonomy({
        user: brainConfigSchema.parse({
          taxonomy: { classifierHints: { ghost: ["boo"] } },
        }),
      })
    ).toThrow(/unknown type/);
  });

  test("config schema rejects typos (strict)", () => {
    expect(() => brainConfigSchema.parse({ taxonomyy: {} })).toThrow();
    expect(() =>
      brainConfigSchema.parse({ taxonomy: { types: { note: { dirr: "x" } } } })
    ).toThrow();
  });
});

describe("repo-relative path containment in config", () => {
  test("accepts relative dirs, '.', and trailing-slash matches", () => {
    expect(() =>
      brainConfigSchema.parse({
        taxonomy: {
          types: {
            index: { dir: ".", match: [] },
            project: { dir: "projects/active", match: ["projects/"] },
          },
        },
      })
    ).not.toThrow();
  });

  test("rejects absolute, ~, backslash, and .. dir values", () => {
    for (const dir of ["/etc", "~/brain", "a\\b", "../outside", "a/../../b"]) {
      expect(() =>
        brainConfigSchema.parse({ taxonomy: { types: { note: { dir } } } })
      ).toThrow();
    }
  });

  test("rejects escaping canonical and dirAnchors entries", () => {
    expect(() =>
      brainConfigSchema.parse({ taxonomy: { canonical: { identity: "/etc/passwd" } } })
    ).toThrow();
    expect(() =>
      brainConfigSchema.parse({ taxonomy: { dirAnchors: ["../_index.md"] } })
    ).toThrow();
  });
});
