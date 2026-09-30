/**
 * `brain tags`: the report through the real bin on a small temp brain, plus
 * the normalization rules it is built from.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { editDistance, findRedundantTags, findVariantGroups, tagKey } from "../src/lib/tags";
import type { TagReport, VariantGroup } from "../src/lib/tags";
import type { TagApplyReport } from "../src/lib/tags-apply";
import { applyTagChanges, contentHash, indexAndAccept } from "../src/lib/tags-apply";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
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
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
  });

  // Optimal string alignment forbids editing a transposed pair again and
  // gives 3 here; the unrestricted distance the rule names gives 2.
  test("editDistance is unrestricted: a transposition followed by an insertion is two edits", () => {
    for (const [a, b] of [["abcdefca", "abcdefabc"], ["woodworkca", "woodworkabc"], ["ca", "abc"]]) {
      expect(editDistance(a, b)).toBe(2);
      expect(editDistance(b, a)).toBe(2);
    }
    const groups = (...tags: string[]) =>
      findVariantGroups(new Map(tags.map((t) => [t, 1])), null).map((g) => g.members.map((m) => m.tag).sort());
    expect(groups("abcdefca", "abcdefabc")).toEqual([["abcdefabc", "abcdefca"]]);
    expect(groups("woodworkabc", "woodworkca")).toEqual([["woodworkabc", "woodworkca"]]);
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

describe("brain tags --apply", () => {
  const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf-8");
  async function apply(root: string, ...flags: string[]): Promise<TagApplyReport & { warnings: string[] }> {
    const { stdout, stderr, code } = await runCli(root, ["tags", "--apply", ...flags, "--json"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  }
  const git = (root: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString();

  // Two byte-identical documents: gray-matter's own cache would hand both the
  // same parsed object (#142), and a rewrite through parsed data would then
  // migrate only one.
  const TWIN = "---\ntitle: Twin\ntype: note\ntags: [trails, hiking]\n---\n\nbody\n";

  test("byte-identical documents both migrate, and every other document keeps its own tags", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, {
      "notes/one.md": TWIN,
      "notes/two.md": TWIN,
      "notes/other.md": note(["trails", "astronomy"]),
    });
    const out = await apply(root);
    expect(out.files).toEqual([
      { path: "notes/one.md", from: ["trails", "hiking"], to: ["trail", "hiking"] },
      { path: "notes/other.md", from: ["trails", "astronomy"], to: ["trail", "astronomy"] },
      { path: "notes/two.md", from: ["trails", "hiking"], to: ["trail", "hiking"] },
    ]);
    const migrated = TWIN.replace("[trails, hiking]", "[trail, hiking]");
    expect(read(root, "notes/one.md")).toBe(migrated);
    expect(read(root, "notes/two.md")).toBe(migrated);
    expect(read(root, "notes/other.md")).toBe(note(["trail", "astronomy"]));
  });

  test("a block list with comments comes out byte-identical except the tag entries", async () => {
    const before = [
      "---",
      "# Owner's note: keep this line",
      'title: "Quoted title"  # an inline comment',
      "type: note",
      "updated: 2026-01-05",
      "tags:",
      "  # trail work",
      "  - trails   # renamed",
      "  - 'hiking'",
      "  - trail",
      "  - wood_working",
      "aliases: [one,two]",
      "---",
      "",
      "tags: [trails] in the body stays",
      "",
    ].join("\n");
    const root = makeBrain({ aliases: { trails: "trail", wood_working: "woodworking" } }, { "notes/block.md": before });
    const out = await apply(root);
    expect(out.files).toEqual([
      { path: "notes/block.md", from: ["trails", "hiking", "trail", "wood_working"], to: ["trail", "hiking", "woodworking"] },
    ]);
    // trails became trail, the later duplicate trail line went, wood_working was renamed.
    expect(read(root, "notes/block.md")).toBe(
      before.replace("  - trails   # renamed", "  - trail   # renamed").replace("  - trail\n", "").replace("  - wood_working", "  - woodworking")
    );
  });

  test("flow sequences keep their quoting and separator, and a new tag is quoted when YAML would retype it", async () => {
    const root = makeBrain({ aliases: { old: "2026", legacy: "kept" } }, {
      "notes/flow.md": '---\ntitle: T\ntype: note\ntags: ["legacy",old,\'x y\'] # trailing\n---\n',
    });
    await apply(root);
    expect(read(root, "notes/flow.md")).toBe('---\ntitle: T\ntype: note\ntags: [kept,"2026",\'x y\'] # trailing\n---\n');
  });

  test("updated is unchanged, and briefing does not list the file as silently modified", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, {
      "notes/dated.md": "---\ntitle: Dated\ntype: note\ncreated: 2026-01-05\nupdated: 2026-01-05\ntags: [trails]\n---\n\nbody\n",
    });
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    await apply(root);
    expect(read(root, "notes/dated.md")).toContain("updated: 2026-01-05\n");
    const { stdout } = await runCli(root, ["briefing"]);
    // The file's mtime is today, past its 2026-01-05 `updated`: without the
    // accepted baseline it would be listed.
    expect(stdout).not.toContain("## Silently Modified");
    const { stdout: tagsAfter } = await runCli(root, ["search", "--tag", "trail", "--json"]);
    expect(JSON.parse(tagsAfter).results.map((r: { path: string }) => r.path)).toEqual(["notes/dated.md"]);
  });

  test("--dry-run reports the changes and leaves git status clean", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.com", "commit", "-qm", "fixture");
    const out = await apply(root, "--dry-run");
    expect(out.files).toEqual([{ path: "notes/b.md", from: ["trails", "hiking"], to: ["trail", "hiking"] }]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("a second run is a no-op", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } });
    expect((await apply(root)).files).toHaveLength(1);
    expect(await apply(root)).toEqual({ files: [], skipped: [], warnings: [] });
  });

  test("variant groups apply when their canonical is in the vocabulary, or all of them with --groups", async () => {
    const vocabulary = { vocabulary: ["trail", "hiking", "astronomy"] };
    const inVocabulary = await apply(makeBrain(vocabulary), "--dry-run");
    expect(inVocabulary.files.map((f) => [f.path, f.to])).toEqual([["notes/b.md", ["trail", "hiking"]]]);
    const all = await apply(makeBrain(vocabulary), "--dry-run", "--groups");
    expect(all.files.map((f) => [f.path, f.to])).toEqual([
      ["notes/b.md", ["trail", "hiking"]],
      ["notes/d.md", ["woodworking", "astronomy"]],
    ]);
  });

  test("--redundant removes a tag that repeats the type, and an emptied list becomes []", async () => {
    const root = makeBrain({}, { "notes/e.md": note(["note", "astronomy"]), "notes/only.md": "---\ntitle: O\ntype: note\ntags:\n  - note\n---\n" });
    const out = await apply(root, "--redundant");
    expect(out.files.map((f) => [f.path, f.to])).toEqual([["notes/e.md", ["astronomy"]], ["notes/only.md", []]]);
    expect(read(root, "notes/e.md")).toBe(note(["astronomy"]));
    expect(read(root, "notes/only.md")).toBe("---\ntitle: O\ntype: note\ntags: []\n---\n");
  });

  test("--only limits the migration to one old tag", async () => {
    const root = makeBrain({ aliases: { trails: "trail", "wood-working": "woodworking" } });
    const out = await apply(root, "--only", "wood-working");
    expect(out.files.map((f) => f.path)).toEqual(["notes/d.md"]);
    expect(read(root, "notes/b.md")).toBe(CORPUS["notes/b.md"]);
  });

  test("a file whose frontmatter does not parse, or whose tags span lines, is skipped and not rewritten", async () => {
    const broken = "---\ntitle: [unclosed\ntags: [trails]\n---\n";
    const multiline = "---\ntitle: M\ntype: note\ntags: [trails,\n  hiking]\n---\n";
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/broken.md": broken, "notes/multi.md": multiline });
    const out = await apply(root);
    expect(out.files).toEqual([]);
    expect(out.skipped).toEqual([
      { path: "notes/broken.md", reason: "frontmatter does not parse" },
      { path: "notes/multi.md", reason: "the tags flow sequence spans more than one line" },
    ]);
    expect(read(root, "notes/broken.md")).toBe(broken);
    expect(read(root, "notes/multi.md")).toBe(multiline);
  });

  test("a byte order mark before the frontmatter stays, and the tags still migrate", async () => {
    const bom = "\uFEFF---\ntitle: B\ntype: note\ntags: [trails]\n---\nbody\n";
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/bom.md": bom });
    await apply(root);
    expect(read(root, "notes/bom.md")).toBe(bom.replace("[trails]", "[trail]"));
  });

  test("CRLF files keep their line endings", async () => {
    const crlf = "---\r\ntitle: C\r\ntype: note\r\ntags:\r\n  - trails\r\n  - hiking\r\n---\r\nbody\r\n";
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/crlf.md": crlf });
    await apply(root);
    expect(read(root, "notes/crlf.md")).toBe(crlf.replace("- trails", "- trail"));
  });

  test("the rewrite flags are refused without --apply", async () => {
    const { code, stderr } = await runCli(makeBrain(), ["tags", "--dry-run"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--dry-run only applies with --apply");
  });
});

describe("brain tags --apply, round 1 of review", () => {
  const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf-8");
  async function apply(root: string, ...flags: string[]): Promise<TagApplyReport & { warnings: string[] }> {
    const { stdout, stderr, code } = await runCli(root, ["tags", "--apply", ...flags, "--json"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  }
  const doc = (tags: string) => `---\ntitle: D\ntype: note\ntags: ${tags}\n---\n\nbody\n`;

  test("an edit made between the read and the write is kept, and the file is skipped", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/a.md": doc("[trails]") });
    const ctx = await initContext({ root });
    const { report, written } = applyTagChanges(root, ctx.taxonomy, {
      beforeCommit: (path) => appendFileSync(join(root, path), "an edit made meanwhile\n"),
    });
    expect(report).toEqual({ files: [], skipped: [{ path: "notes/a.md", reason: "changed during apply" }] });
    expect(written.size).toBe(0);
    expect(read(root, "notes/a.md")).toBe(doc("[trails]") + "an edit made meanwhile\n");
    // The temporary file with the planned rewrite is gone too.
    expect(readdirSync(join(root, "notes"))).toEqual(["a.md"]);
  });

  test("the mtime is accepted only for the bytes the rewrite wrote", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, {
      "notes/a.md": doc("[trails]"),
      "notes/b.md": doc("[trails, hiking]"),
    });
    const ctx = await initContext({ root });
    const { written } = applyTagChanges(root, ctx.taxonomy, {});
    expect([...written.keys()]).toEqual(["notes/a.md", "notes/b.md"]);
    expect(written.get("notes/a.md")).toBe(contentHash(read(root, "notes/a.md")));
    appendFileSync(join(root, "notes/b.md"), "edited after the rewrite\n");
    const db = openDatabase(ctx.dbPath);
    try {
      const warnings = await indexAndAccept(db, root, ctx.taxonomy, written);
      expect(warnings).toEqual(["notes/b.md changed after its tags were rewritten; its mtime was not accepted"]);
      const accepted = (path: string) =>
        (db.prepare("SELECT accepted_mtime FROM documents WHERE path = ?").get(path) as { accepted_mtime: string | null }).accepted_mtime;
      expect(accepted("notes/a.md")).not.toBeNull();
      expect(accepted("notes/b.md")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an alias target is not renamed away by a variant group, and a second run plans nothing", async () => {
    const root = makeBrain({ aliases: { legacy: "trails" }, vocabulary: ["trail"] }, {
      "notes/a.md": doc("[legacy]"),
      "notes/b.md": doc("[trail]"),
    });
    expect((await apply(root)).files).toEqual([{ path: "notes/a.md", from: ["legacy"], to: ["trails"] }]);
    expect((await apply(root)).files).toEqual([]);
  });

  test("an explicit alias beats the vocabulary's pick for the group", async () => {
    const root = makeBrain({ aliases: { trails: "trail" }, vocabulary: ["trails"] }, {
      "notes/a.md": doc("[trails]"),
      "notes/b.md": doc("[trail, trails]"),
    });
    expect((await apply(root)).files).toEqual([
      { path: "notes/a.md", from: ["trails"], to: ["trail"] },
      { path: "notes/b.md", from: ["trail", "trails"], to: ["trail"] },
    ]);
    expect((await apply(root)).files).toEqual([]);
  });

  test("an alias cycle is reported and its files are left alone, run after run", async () => {
    const root = makeBrain({ aliases: { aa: "bb", bb: "cc", cc: "bb" } }, {
      "notes/a.md": doc("[aa, hiking]"),
      "notes/b.md": doc("[bb]"),
    });
    for (let run = 0; run < 2; run++) {
      const out = await apply(root);
      expect(out.files).toEqual([]);
      expect(out.skipped).toEqual([
        { path: "notes/a.md", reason: "tag alias cycle: aa → bb → cc → bb" },
        { path: "notes/b.md", reason: "tag alias cycle: bb → cc → bb" },
      ]);
    }
    expect(read(root, "notes/a.md")).toBe(doc("[aa, hiking]"));
  });

  test("a flow sequence keeps the gaps around untouched entries, commas in quotes included", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, {
      "notes/a.md": doc("[ trails,  hiking ,astronomy, ]"),
      "notes/b.md": doc('["x, y", trails,hiking]'),
      "notes/c.md": doc("[ trails,  hiking ,trail, ]"),
    });
    await apply(root);
    expect(read(root, "notes/a.md")).toBe(doc("[ trail,  hiking ,astronomy, ]"));
    expect(read(root, "notes/b.md")).toBe(doc('["x, y", trail,hiking]'));
    // The merged duplicate goes with the gap before it, at the end of the list.
    expect(read(root, "notes/c.md")).toBe(doc("[ trail,  hiking, ]"));
  });

  test("a dropped block entry's comment stays as a comment line", async () => {
    const before = "---\ntitle: D\ntype: note\ntags:\n  - trails\n  - trail # preserve me\n  - hiking\n---\n";
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/a.md": before });
    await apply(root);
    expect(read(root, "notes/a.md")).toBe(
      "---\ntitle: D\ntype: note\ntags:\n  - trail\n  # preserve me\n  - hiking\n---\n"
    );
  });

  test("--only touches only its tag and the collision it causes", async () => {
    const root = makeBrain({ aliases: { trails: "trail", "wood-working": "woodworking" } }, {
      "notes/a.md": doc("[trails, trail, foo, foo, wood-working]"),
      "notes/b.md": doc("[foo, foo]"),
    });
    const out = await apply(root, "--only", "trails");
    expect(out.files).toEqual([
      { path: "notes/a.md", from: ["trails", "trail", "foo", "foo", "wood-working"], to: ["trail", "foo", "foo", "wood-working"] },
    ]);
    expect(read(root, "notes/b.md")).toBe(doc("[foo, foo]"));
  });

  test("without --only, duplicates the plan did not produce stay too", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/a.md": doc("[foo, foo, trails]") });
    expect((await apply(root)).files).toEqual([{ path: "notes/a.md", from: ["foo", "foo", "trails"], to: ["foo", "foo", "trail"] }]);
  });

  test("a rewrite that would not read back as the planned tags is refused, and nothing is written", async () => {
    // A date-shaped target written plain reads back as a YAML date.
    const root = makeBrain({ aliases: { old: "2026-01-05" } }, { "notes/a.md": doc("[old, hiking]") });
    const out = await apply(root);
    expect(out.files).toEqual([]);
    expect(out.skipped).toEqual([{ path: "notes/a.md", reason: "the rewrite did not read back as the planned tags" }]);
    expect(read(root, "notes/a.md")).toBe(doc("[old, hiking]"));
  });

  test("an unreadable file is reported, and the files already rewritten are still indexed and accepted", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, {
      "notes/a.md": "---\ntitle: A\ntype: note\ncreated: 2026-01-05\nupdated: 2026-01-05\ntags: [trails]\n---\n",
      "notes/b.md": doc("[trails]"),
    });
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    chmodSync(join(root, "notes/b.md"), 0o000);
    try {
      const { stdout, code } = await runCli(root, ["tags", "--apply", "--json"]);
      expect(code).toBe(2);
      const out = JSON.parse(stdout);
      expect(out.files).toEqual([{ path: "notes/a.md", from: ["trails"], to: ["trail"] }]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0].path).toBe("notes/b.md");
      expect(out.skipped[0].reason).toStartWith("failed: ");
      // Indexed: the new tag is searchable. Accepted: briefing stays quiet.
      const { stdout: found } = await runCli(root, ["search", "--tag", "trail", "--json"]);
      expect(JSON.parse(found).results.map((r: { path: string }) => r.path)).toEqual(["notes/a.md"]);
      const { stdout: briefing } = await runCli(root, ["briefing"]);
      expect(briefing).not.toContain("## Silently Modified");
    } finally {
      chmodSync(join(root, "notes/b.md"), 0o644);
    }
  });

  test("--apply refuses to write in a directory with no brain.config, and --dry-run still reads", async () => {
    const root = makeTempBrain({ empty: true });
    brains.push(root);
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes/a.md"), doc("[trails]"));
    const refused = await runCli(root, ["tags", "--apply", "--groups"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("refusing to modify an uninitialized directory");
    expect((await runCli(root, ["tags", "--apply", "--dry-run", "--json"])).code).toBe(0);
    expect(read(root, "notes/a.md")).toBe(doc("[trails]"));
  });
});

describe("brain tags --apply, round 2 of review", () => {
  const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf-8");
  const doc = (tags: string) => `---\ntitle: D\ntype: note\ntags: ${tags}\n---\n\nbody\n`;

  test("with --redundant, the plan counts the tags left after removal, so a second run is a no-op", async () => {
    const root = makeBrain({ aliases: { unused: "trails" } }, {
      "trail/a.md": doc("[trail]"),
      "trail/b.md": doc("[trail]"),
      "trail/c.md": doc("[trail]"),
      "notes/d.md": doc("[tr_ail]"),
      "notes/e.md": doc("[trails]"),
      "notes/f.md": doc("[trails]"),
    });
    const run = async () => {
      const { stdout, code } = await runCli(root, ["tags", "--apply", "--groups", "--redundant", "--json"]);
      expect(code).toBe(0);
      return JSON.parse(stdout) as TagApplyReport;
    };
    const first = await run();
    // The trail/ documents lose their directory tag, so `trails` is the
    // group's most used form once the plan is applied, and tr_ail joins it.
    expect(first.files.map((f) => [f.path, f.to])).toEqual([
      ["notes/d.md", ["trails"]],
      ["trail/a.md", []],
      ["trail/b.md", []],
      ["trail/c.md", []],
    ]);
    expect((await run()).files).toEqual([]);
  });

  test("an index that cannot be opened stops the run before any file is rewritten", async () => {
    const root = makeBrain({ aliases: { trails: "trail" } }, { "notes/a.md": doc("[trails]") });
    // A directory where the database file should be: SQLite cannot open it.
    mkdirSync(join(root, "brain.db"));
    const { stdout, code } = await runCli(root, ["tags", "--apply", "--json"]);
    expect(code).toBe(2);
    const out = JSON.parse(stdout);
    expect(out.files).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toStartWith("cannot open the index");
    expect(read(root, "notes/a.md")).toBe(doc("[trails]"));
    // Once the index opens again, the retry does the whole migration.
    rmSync(join(root, "brain.db"), { recursive: true });
    const retry = await runCli(root, ["tags", "--apply", "--json"]);
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout).files).toEqual([{ path: "notes/a.md", from: ["trails"], to: ["trail"] }]);
  });
});
