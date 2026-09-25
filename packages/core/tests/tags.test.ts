/**
 * `brain tags`: the report through the real bin on a small temp brain, plus
 * the normalization rules it is built from.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { editDistance, findRedundantTags, findVariantGroups, tagKey } from "../src/lib/tags";
import type { TagReport, VariantGroup } from "../src/lib/tags";
import type { TagsConfig } from "../src/lib/config";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const brains: string[] = [];
afterAll(() => brains.forEach(cleanup));

function note(tags: string[], type = "note"): string {
  return `---\ntitle: Note\ntype: ${type}\ntags: [${tags.join(", ")}]\n---\n\nbody\n`;
}

// trail/trails differ by a plural, wood-working/woodworking by a hyphen, and
// notes/e.md is tagged with its own type. Every other tag stands alone.
const CORPUS: Record<string, string> = {
  "notes/a.md": note(["trail", "hiking"]),
  "notes/b.md": note(["trails", "hiking"]),
  "notes/c.md": note(["trail", "woodworking"]),
  "notes/d.md": note(["wood-working", "astronomy"]),
  "notes/e.md": note(["note", "astronomy"]),
};

function makeBrain(tagsConfig?: object, files: Record<string, string> = CORPUS): string {
  const root = makeTempBrain({ empty: true });
  brains.push(root);
  const config = tagsConfig ? { taxonomy: { tags: tagsConfig } } : {};
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(config));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

async function report(root: string): Promise<TagReport> {
  const { stdout, stderr, code } = await runCli(root, ["tags", "--json"]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

const shape = (r: TagReport) =>
  r.variantGroups.map((g) => ({ canonical: g.canonical, members: g.members.map((m) => m.tag).sort() }));

describe("brain tags", () => {
  test("reports exactly the two variant groups and the one redundant tag", async () => {
    const out = await report(makeBrain());
    for (const group of out.variantGroups) expect(group.members.length).toBeGreaterThan(0);
    expect(shape(out)).toEqual([
      { canonical: "trail", members: ["trail", "trails"] },
      { canonical: "woodworking", members: ["wood-working", "woodworking"] },
    ]);
    expect(out.variantGroups[0].members).toEqual([
      { tag: "trail", count: 2 },
      { tag: "trails", count: 1 },
    ]);
    expect(out.redundant).toEqual([{ path: "notes/e.md", tag: "note", repeats: "type" }]);
    expect(out).toMatchObject({ tags: 7, documents: 5, aliasHits: [], outOfVocabulary: null });
  });

  test("a vocabulary member wins the canonical choice over the more used form", async () => {
    const out = await report(makeBrain({ vocabulary: ["trails", "woodworking", "hiking", "astronomy"] }));
    expect(shape(out)[0]).toEqual({ canonical: "trails", members: ["trail", "trails"] });
    expect(out.outOfVocabulary).toEqual([
      { tag: "trail", count: 2 },
      { tag: "note", count: 1 },
      { tag: "wood-working", count: 1 },
    ]);
  });

  test("inflection off stops trail/trails grouping, and -/_ stripping still groups", async () => {
    const out = await report(makeBrain({ inflection: "off" }));
    expect(shape(out)).toEqual([{ canonical: "woodworking", members: ["wood-working", "woodworking"] }]);
  });

  test("lists documents that still carry an alias key", async () => {
    const out = await report(makeBrain({ aliases: { trails: "trail" } }));
    expect(out.aliasHits).toEqual([{ path: "notes/b.md", tag: "trails", canonical: "trail" }]);
  });

  test("redundant: off drops the redundant list", async () => {
    const out = await report(makeBrain({ redundant: "off" }));
    expect(out.redundant).toEqual([]);
    expect(out.variantGroups).toHaveLength(2);
  });

  test("an invalid taxonomy.tags block is a config error", async () => {
    const root = makeBrain({ inflection: "de" });
    const { code, stderr } = await runCli(root, ["tags", "--json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("inflection");
  });
});

describe("brain maintain", () => {
  test("carries a tags step with the counts and still exits 0", async () => {
    const root = makeBrain();
    const { stdout, code } = await runCli(root, ["maintain", "--json"]);
    expect(code).toBe(0);
    const steps = JSON.parse(stdout) as { step: string; result: string }[];
    expect(steps.find((s) => s.step === "tags")?.result).toBe(
      "2 variant group(s), 1 redundant tag(s), 0 alias hit(s)"
    );
  });
});

describe("normalization", () => {
  test("tagKey strips separators and applies the English singular with a 3-letter minimum stem", () => {
    expect(tagKey("wood_working")).toBe("woodworking");
    expect(tagKey("stories")).toBe("story");
    expect(tagKey("boxes")).toBe("box");
    expect(tagKey("notes")).toBe("note");
    expect(tagKey("class")).toBe("class");
    expect(tagKey("ies")).toBe("ies");
    expect(tagKey("bus")).toBe("bus");
    expect(tagKey("trails", "off")).toBe("trails");
  });

  test("editDistance counts a transposition as one edit", () => {
    expect(editDistance("recieve", "receive")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  test("distance groups by length band, and never across digits", () => {
    const groups = (...tags: string[]) =>
      findVariantGroups(new Map(tags.map((t) => [t, 1])), null).map((g) => g.members.map((m) => m.tag).sort());
    expect(groups("sub-agent", "subagnet")).toEqual([["sub-agent", "subagnet"]]); // 8+ chars: transposition
    expect(groups("recipe", "recipy")).toEqual([["recipe", "recipy"]]); // 5-7 chars: distance 1
    expect(groups("recipe", "rectpy")).toEqual([]); // 5-7 chars: distance 2 is too far
    expect(groups("bike", "bake")).toEqual([]); // under 5 chars: exact keys only
    expect(groups("trade", "trader")).toEqual([]); // an ending is inflection's call, not a typo
    expect(groups("q1-2026", "q2-2026")).toEqual([]);
    expect(groups("mountain", "muontian")).toEqual([["mountain", "muontian"]]); // 8+ chars: exactly 2 edits
    expect(groups("mountain", "muontina")).toEqual([]); // 8+ chars: 3 edits
  });

  test("a middle tag never chains two tags the rules keep apart", () => {
    const together = (groups: VariantGroup[], a: string, b: string) =>
      groups.some((g) => g.members.some((m) => m.tag === a) && g.members.some((m) => m.tag === b));
    const run = (tags: string[], config: TagsConfig | null = null) =>
      findVariantGroups(new Map(tags.map((t) => [t, 1])), config);

    // tradre is one edit from each; trade/trader is an ending, never a typo.
    const trade = run(["trade", "tradre", "trader"]);
    expect(trade.length).toBeGreaterThan(0);
    expect(together(trade, "trade", "trader")).toBe(false);

    // With inflection off, a misspelt plural must not rejoin trail and trails.
    const trail = run(["trail", "traisl", "trails"], { inflection: "off" });
    expect(trail.length).toBeGreaterThan(0);
    expect(together(trail, "trail", "trails")).toBe(false);

    // A distance chain: each neighbour is one edit apart, the ends two.
    const chain = run(["recipe", "recipy", "racipy"]);
    expect(chain.length).toBeGreaterThan(0);
    expect(together(chain, "recipe", "racipy")).toBe(false);
  });

  test("lengths count characters, not UTF-16 units", () => {
    const groups = (...tags: string[]) =>
      findVariantGroups(new Map(tags.map((t) => [t, 1])), null).map((g) => g.members.map((m) => m.tag).sort());
    // Three supplementary-plane characters: under 5, so no distance matching.
    expect(groups("\u{20000}\u{20001}\u{20002}", "\u{20000}\u{20001}\u{20003}")).toEqual([]);
    // Five of them, one substitution apart: inside the 5-7 band.
    expect(groups("\u{20000}\u{20001}\u{20002}\u{20004}\u{20005}", "\u{20000}\u{20001}\u{20003}\u{20004}\u{20005}")).toHaveLength(1);
    // One character replaced by one character is one edit, surrogate pair or not.
    expect(editDistance("a\u{20000}", "ab")).toBe(1);
    // The singular's minimum stem counts characters too: two, plus an s, is too short.
    expect(tagKey("\u{20000}\u{20001}s")).toBe("\u{20000}\u{20001}s");
  });

  test("digits in any script keep tags apart", () => {
    const groups = (...tags: string[]) => findVariantGroups(new Map(tags.map((t) => [t, 1])), null);
    expect(groups("\uFF11\uFF12\uFF13\uFF14\uFF15", "\uFF11\uFF12\uFF13\uFF14\uFF16")).toEqual([]); // fullwidth
    expect(groups("\u0661\u0662\u0663\u0664\u0665", "\u0661\u0662\u0663\u0664\u0666")).toEqual([]); // Arabic-Indic
  });

  test("canonical ties break on the shorter tag, then alphabetically", () => {
    const [group] = findVariantGroups(new Map([["wood-working", 1], ["woodworking", 1]]), null);
    expect(group.canonical).toBe("woodworking");
    // Same count, same length, same key, inserted in reverse alphabetical
    // order, so neither insertion nor key order can pick the winner.
    const [tie] = findVariantGroups(new Map([["wood_work", 1], ["wood-work", 1]]), null);
    expect(tie.members.map((m) => m.tag)).toEqual(["wood-work", "wood_work"]);
    expect(tie.canonical).toBe("wood-work");
  });

  test("a tag equal to a directory of the document's path is redundant", () => {
    expect(
      findRedundantTags([{ path: "projects/garden/plan.md", type: "project", tags: ["garden", "plan", "soil"] }])
    ).toEqual([{ path: "projects/garden/plan.md", tag: "garden", repeats: "directory" }]);
  });
});
