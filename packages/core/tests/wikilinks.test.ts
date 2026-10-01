import { describe, expect, test } from "bun:test";
import { createWikiLinkResolver } from "../src/lib/indexer/links";

import {
  extractWikiLinks,
  resolveWikiLink,
  resolveAlias,
} from "../src/lib/indexer";

// Neutral corpus for the fictional persona "Alex Example" (park ranger:
// health, woodworking projects, evening astronomy studies). No personal slugs.

describe("extractWikiLinks", () => {
  test("extracts unique targets", () => {
    const links = extractWikiLinks("see [[identity]] and [[identity]] plus [[current-focus]]");
    expect(links).toEqual(["identity", "current-focus"]);
  });

  test("returns empty array when no links", () => {
    expect(extractWikiLinks("no links here")).toEqual([]);
  });

  test("takes the target before a pipe alias", () => {
    expect(extractWikiLinks("see [[identity|who Alex is]]")).toEqual(["identity"]);
  });

  test("ignores wiki-link-looking syntax inside code", () => {
    const content = "```js\nconst m = [['a',1]];\n```\nand `[[inline]]` but [[real-link]]";
    expect(extractWikiLinks(content)).toEqual(["real-link"]);
  });
});

describe("resolveWikiLink", () => {
  test("self-heading links resolve only to a source present in the corpus snapshot", () => {
    const source = "notes/anchor-test.md";
    const resolve = createWikiLinkResolver(new Map([[source, "Anchor test"]]));
    expect(resolve("#Section one", source)).toBe(source);
    expect(resolve(" #Section one ", source)).toBe(source);
    expect(resolve("#Absent heading", source)).toBe(source);
    expect(resolve("#Section one")).toBeNull();
    expect(resolve("#Section one", "notes/missing.md")).toBeNull();
    expect(resolve("", source)).toBeNull();
    expect(resolve("   ", source)).toBeNull();
    expect(resolve("#", source)).toBeNull();
    expect(resolve("#   ", source)).toBeNull();
  });

  test("exact qualified paths beat suffixes in either insertion order", () => {
    const paths = ["archive/projects/demo.md", "projects/demo.md"];
    for (const order of [paths, paths.toReversed()]) {
      const map = new Map(order.map((path) => [path, path]));
      expect(resolveWikiLink("projects/demo", map)).toBe("projects/demo.md");
      expect(resolveWikiLink("projects/demo.md#section", map)).toBe("projects/demo.md");
    }
  });

  test("qualified suffixes require an unambiguous source scope", () => {
    const paths = ["archive/projects/demo.md", "active/projects/demo.md"];
    for (const order of [paths, paths.toReversed()]) {
      const resolve = createWikiLinkResolver(new Map(order.map((path) => [path, path])));
      expect(resolve("projects/demo")).toBeNull();
      expect(resolve("projects/demo", "notes/overview.md")).toBeNull();
      expect(resolve("projects/demo", "active/overview.md")).toBe("active/projects/demo.md");
    }
  });

  test("a namesake subdirectory with multiple matches stays ambiguous", () => {
    const paths = ["studies/astronomy/north/log.md", "studies/astronomy/south/log.md"];
    for (const order of [paths, paths.toReversed()]) {
      expect(resolveWikiLink("log", new Map(order.map((p) => [p, p])), "studies/astronomy.md")).toBeNull();
    }
  });

  test("a new corpus snapshot sees added ambiguity and configured anchor priority", () => {
    const map = new Map([["active/demo/log.md", "Log"], ["active/demo/_index.md", "Index"], ["active/demo/status.md", "Status"]]);
    const first = createWikiLinkResolver(map, ["status.md", "_index.md"]);
    expect(first("log")).toBe("active/demo/log.md");
    expect(first("demo/")).toBe("active/demo/status.md");
    map.set("archive/demo/log.md", "Archived log");
    const next = createWikiLinkResolver(map);
    expect(next("log")).toBeNull();
    expect(next("demo/")).toBe("active/demo/_index.md");
  });
  const fileMap = new Map([
    ["me/identity.md", "Identity"],
    ["context/current-focus.md", "Current Focus"],
    ["studies/_index.md", "Studies Index"],
    ["projects/active/bookshelf/research.md", "Bookshelf Research"],
    ["projects/active/canoe-rack/research.md", "Canoe Rack Research"],
    ["studies/astronomy.md", "Astronomy"],
    ["studies/astronomy/observation-log.md", "Astronomy Observation Log"],
    ["studies/botany/observation-log.md", "Botany Observation Log"],
  ]);

  test("resolves exact basename", () => {
    expect(resolveWikiLink("identity", fileMap)).toBe("me/identity.md");
    expect(resolveWikiLink("current-focus", fileMap)).toBe("context/current-focus.md");
  });

  test("resolves _index files without underscore", () => {
    expect(resolveWikiLink("index", fileMap)).toBe("studies/_index.md");
  });

  test("returns null for unknown targets", () => {
    expect(resolveWikiLink("does-not-exist", fileMap)).toBeNull();
  });

  test("ambiguous basename resolves to same-directory sibling", () => {
    expect(
      resolveWikiLink("research", fileMap, "projects/active/canoe-rack/status.md")
    ).toBe("projects/active/canoe-rack/research.md");
    expect(
      resolveWikiLink("research", fileMap, "projects/active/bookshelf/status.md")
    ).toBe("projects/active/bookshelf/research.md");
  });

  test("ambiguous basename resolves into namesake subdirectory", () => {
    expect(
      resolveWikiLink("observation-log", fileMap, "studies/astronomy.md")
    ).toBe("studies/astronomy/observation-log.md");
  });

  test("ambiguous basename without disambiguating source returns null", () => {
    expect(resolveWikiLink("research", fileMap)).toBeNull();
    expect(resolveWikiLink("research", fileMap, "me/identity.md")).toBeNull();
  });

  test("qualified path link resolves by suffix", () => {
    expect(resolveWikiLink("bookshelf/research", fileMap, "me/identity.md")).toBe(
      "projects/active/bookshelf/research.md"
    );
  });

  test("directory link resolves to the directory's anchor file", () => {
    // No file basename "canoe-rack" exists, so [[canoe-rack]] falls to the
    // directory-anchor step. Default anchors are just _index.md, which the dir
    // lacks — so it stays unresolved until a configured anchor is present.
    expect(resolveWikiLink("canoe-rack", fileMap, "me/identity.md")).toBeNull();
    const withStatus = new Map([
      ...fileMap,
      ["projects/active/canoe-rack/status.md", "Canoe Rack Status"],
    ]);
    // status.md only counts as an anchor when the taxonomy's dirAnchors say so.
    expect(
      resolveWikiLink("canoe-rack", withStatus, "me/identity.md", ["_index.md", "status.md"])
    ).toBe("projects/active/canoe-rack/status.md");
  });

  test("[[_index]] resolves to the nearest ancestor index", () => {
    const maps = new Map([
      ["projects/active/_index.md", "Active Projects Index"],
      ["studies/_index.md", "Studies Index"],
      ["projects/active/bookshelf/status.md", "Bookshelf"],
    ]);
    expect(
      resolveWikiLink("_index", maps, "projects/active/bookshelf/status.md")
    ).toBe("projects/active/_index.md");
  });

  test("heading fragments are stripped before resolving", () => {
    expect(resolveWikiLink("identity#background", fileMap, "studies/_index.md")).toBe(
      "me/identity.md"
    );
  });
});

describe("resolveWikiLink — directory links (bare name and trailing slash)", () => {
  test("a trailing-slash qualified path resolves to the directory's anchor", () => {
    const maps = new Map([
      ["projects/active/bookshelf/_index.md", "Bookshelf Index"],
      ["projects/active/bookshelf/research.md", "Bookshelf Research"],
      ["me/identity.md", "Identity"],
    ]);
    expect(resolveWikiLink("projects/active/bookshelf/", maps, "me/identity.md")).toBe(
      "projects/active/bookshelf/_index.md"
    );
    // Heading fragments are still stripped ahead of the trailing-slash check.
    expect(resolveWikiLink("projects/active/bookshelf/#plans", maps, "me/identity.md")).toBe(
      "projects/active/bookshelf/_index.md"
    );
  });

  test("a trailing slash forces the directory even when a same-named .md exists", () => {
    const maps = new Map([
      ["projects/active/bookshelf/_index.md", "Bookshelf Index"],
      ["projects/active/bookshelf.md", "Bookshelf Registry"],
      ["me/identity.md", "Identity"],
    ]);
    // Bare name → the registry file wins (basename match).
    expect(resolveWikiLink("bookshelf", maps, "me/identity.md")).toBe(
      "projects/active/bookshelf.md"
    );
    // Trailing slash → the directory anchor, never the same-named file.
    expect(resolveWikiLink("bookshelf/", maps, "me/identity.md")).toBe(
      "projects/active/bookshelf/_index.md"
    );
  });

  test("directory links honor dirAnchors order", () => {
    const maps = new Map([
      ["projects/active/canoe-rack/status.md", "Canoe Rack Status"],
      ["me/identity.md", "Identity"],
    ]);
    // Default anchors are just _index.md → unresolved.
    expect(resolveWikiLink("projects/active/canoe-rack/", maps, "me/identity.md")).toBeNull();
    // With status.md configured as an anchor → resolves.
    expect(
      resolveWikiLink("projects/active/canoe-rack/", maps, "me/identity.md", ["_index.md", "status.md"])
    ).toBe("projects/active/canoe-rack/status.md");
  });
});

describe("resolveAlias", () => {
  test("resolves a frontmatter alias case-insensitively", () => {
    const aliasMap = new Map([["stargazing", ["studies/astronomy.md"]]]);
    expect(resolveAlias("stargazing", aliasMap)).toBe("studies/astronomy.md");
    expect(resolveAlias("Stargazing", aliasMap)).toBe("studies/astronomy.md");
  });

  test("ambiguous alias resolves by source proximity, else null", () => {
    const aliasMap = new Map([
      ["log", ["studies/astronomy/observation-log.md", "studies/botany/observation-log.md"]],
    ]);
    expect(resolveAlias("log", aliasMap)).toBeNull();
    expect(resolveAlias("log", aliasMap, "studies/astronomy/notes.md")).toBe(
      "studies/astronomy/observation-log.md"
    );
  });
});
