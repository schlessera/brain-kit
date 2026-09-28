/**
 * The merge library's edges that the goldens do not reach: refusals, the
 * judgment round trip, strategy choice, the frontmatter rules, and the config
 * that selects them.
 */

import { describe, expect, test } from "bun:test";

import { brainConfigSchema, typeSpecSchema } from "../src/lib/config";
import { mergeFrontmatter } from "../src/lib/sync/resolve/frontmatter";
import { parseDoc } from "../src/lib/sync/resolve/markdown";
import { MAX_MERGE_BYTES, pairId, planMerge, remotePath, type MergeOutcome } from "../src/lib/sync/resolve/plan";
import { strategyFor } from "../src/lib/sync/resolve/strategy";
import { buildTaxonomy } from "../src/lib/taxonomy";

const taxonomy = buildTaxonomy({});

const doc = (updated: string | null, body: string, extra = "") =>
  `---\ntitle: "Night Sky Log"\n${updated ? `updated: ${updated}\n` : ""}${extra}---\n${body}`;

function resolvedContent(outcome: MergeOutcome): string {
  expect(outcome.status).toBe("resolved");
  if (outcome.status !== "resolved" || outcome.content === null) throw new Error("expected content");
  return outcome.content;
}

describe("planMerge refuses what it must not merge", () => {
  const base = doc("2026-05-01", "\n## Log\n\n- Saturn at dawn.\n");
  const ours = doc("2026-05-02", "\n## Log\n\n- Saturn at dawn, seeing 3/5.\n");
  const theirs = doc("2026-05-03", "\n## Log\n\n- Saturn at dawn; clouds by six.\n");

  test("a side with a NUL byte is binary", () => {
    const outcome = planMerge({ path: "studies/log.md", base, ours: ours + "\u0000", theirs }, "synthesize").render(new Map());
    expect(outcome).toEqual({ status: "unresolved", reason: "binary: a side contains a NUL byte" });
  });

  test("a side over 100 KB is refused by bytes, not characters", () => {
    const fill = (bytes: number) => doc("2026-05-02", "\n## Log\n\n" + "a".repeat(bytes - doc("2026-05-02", "\n## Log\n\n\n").length) + "\n");
    const atLimit = fill(MAX_MERGE_BYTES);
    expect(Buffer.byteLength(atLimit)).toBe(MAX_MERGE_BYTES);
    expect(planMerge({ path: "studies/log.md", base, ours: atLimit, theirs }, "synthesize").render(new Map()).status).toBe("resolved");

    // 51 201 two-byte characters: fewer characters than the limit, more bytes.
    const wide = doc("2026-05-02", "\n## Log\n\n" + "é".repeat(51_201) + "\n");
    expect(wide.length).toBeLessThan(MAX_MERGE_BYTES);
    const outcome = planMerge({ path: "studies/log.md", base, ours: wide, theirs }, "synthesize").render(new Map());
    expect(outcome.status).toBe("unresolved");
    if (outcome.status === "unresolved") expect(outcome.reason).toContain("too large");
  });

  test("frontmatter that is not YAML is unparseable", () => {
    const broken = "---\ntitle: [unclosed\n---\n\n## Log\n\n- Saturn.\n";
    const outcome = planMerge({ path: "studies/log.md", base, ours: broken, theirs }, "synthesize").render(new Map());
    expect(outcome.status).toBe("unresolved");
    if (outcome.status === "unresolved") expect(outcome.reason).toStartWith("unparseable: ours:");
  });

  test("code-merge and cache-union never merge, even when a side is unchanged", () => {
    expect(planMerge({ path: "scripts/a.sh", base: "x\n", ours: "x\n", theirs: "y\n" }, "code-merge").render(new Map()).status).toBe("unresolved");
    expect(planMerge({ path: ".context-cache.jsonl", base: "x\n", ours: "x\n", theirs: "y\n" }, "cache-union").render(new Map())).toEqual({
      status: "unresolved",
      reason: "cache-union: handled by pull",
    });
  });

  test("deleted on both sides is deleted", () => {
    expect(planMerge({ path: "studies/log.md", base, ours: null, theirs: null }, "synthesize").render(new Map())).toEqual({
      status: "resolved",
      content: null,
      extraFiles: [],
      notes: [],
    });
  });
});

describe("judgment pairs", () => {
  const base = doc("2026-05-01", "\n## Log\n\n- Saturn at dawn.\n");
  const ours = doc("2026-05-02", "\n## Log\n\n- Saturn at dawn, seeing 3/5.\n");
  const theirs = doc("2026-05-03", "\n## Log\n\n- Saturn at dawn; clouds by six.\n");

  test("a pair's id is a stable hash of path, context and both texts", () => {
    const plan = planMerge({ path: "studies/log.md", base, ours, theirs }, "synthesize");
    expect(plan.pairs).toEqual([
      {
        id: pairId("studies/log.md", "Log", "- Saturn at dawn, seeing 3/5.", "- Saturn at dawn; clouds by six."),
        path: "studies/log.md",
        context: "Log",
        ours: "- Saturn at dawn, seeing 3/5.",
        theirs: "- Saturn at dawn; clouds by six.",
      },
    ]);
    expect(planMerge({ path: "studies/log.md", base, ours, theirs }, "synthesize").pairs[0]!.id).toBe(plan.pairs[0]!.id);
    expect(pairId("studies/log.md", "Other", "a", "b")).not.toBe(pairId("studies/log.md", "Log", "a", "b"));
    expect(pairId("studies/other.md", "Log", "a", "b")).not.toBe(pairId("studies/log.md", "Log", "a", "b"));
  });

  test("each decision renders its own version, and render keeps no state between calls", () => {
    const plan = planMerge({ path: "studies/log.md", base, ours, theirs }, "synthesize");
    const id = plan.pairs[0]!.id;
    const body = (decision?: "same-fact" | "ours-supersedes" | "theirs-supersedes" | "distinct") =>
      resolvedContent(plan.render(new Map(decision ? [[id, decision]] : []))).split("## Log\n\n")[1];
    const undecided = body();
    expect(body("same-fact")).toBe("- Saturn at dawn, seeing 3/5.\n");
    expect(body("ours-supersedes")).toBe("- Saturn at dawn, seeing 3/5.\n");
    expect(body("theirs-supersedes")).toBe("- Saturn at dawn; clouds by six.\n");
    expect(body("distinct")).toBe("- Saturn at dawn; clouds by six.\n- Saturn at dawn, seeing 3/5.\n");
    expect(body()).toBe(undecided);
  });

  test("an undecided pair keeps both, the later `updated` first and OURS first on a tie or a missing date", () => {
    const order = (oursUpdated: string | null, theirsUpdated: string | null) => {
      const outcome = planMerge(
        {
          path: "studies/log.md",
          base: doc("2026-05-01", "\n## Log\n\n- Saturn at dawn.\n"),
          ours: doc(oursUpdated, "\n## Log\n\n- OURS line.\n"),
          theirs: doc(theirsUpdated, "\n## Log\n\n- THEIRS line.\n"),
        },
        "synthesize"
      ).render(new Map());
      return resolvedContent(outcome).split("## Log\n\n")[1];
    };
    expect(order("2026-05-02", "2026-05-03")).toBe("- THEIRS line.\n- OURS line.\n");
    expect(order("2026-05-03", "2026-05-02")).toBe("- OURS line.\n- THEIRS line.\n");
    expect(order("2026-05-03", "2026-05-03")).toBe("- OURS line.\n- THEIRS line.\n");
    expect(order(null, "2026-05-03")).toBe("- OURS line.\n- THEIRS line.\n");
    // A timestamp later on the same day is later: dates are compared as dates.
    expect(order("2026-05-03", "2026-05-03T09:00:00Z")).toBe("- THEIRS line.\n- OURS line.\n");
  });
});

describe("alignment", () => {
  test("a table stays aligned with itself when a new table with the same header lands above it", () => {
    // Keyed by header alone, BASE's table would align with OURS' new one, and
    // OURS' copy of the old table would become an insertion paired against
    // THEIRS' new item: a judgment that could drop the old table's rows.
    // The paragraph after it keeps the ends from lining up, so the aligner's
    // weights decide, not its shortcut for identical ends.
    const table = (rows: string[]) => ["| Key | Note |", "|-----|------|", ...rows].join("\n");
    const page = (updated: string, blocks: string[]) => doc(updated, `\n## Tools\n\n${blocks.join("\n\n")}\n`);
    const plan = planMerge(
      {
        path: "_index.md",
        base: page("2026-05-01", [table(["| Chisels | wall rack |"])]),
        ours: page("2026-05-02", [table(["| Scraper | drawer 1 |"]), table(["| Chisels | wall rack |"]), "Both tables live in the shop."]),
        theirs: page("2026-05-03", [table(["| Chisels | wall rack |"]), "- Sharpen before the trail-sign build."]),
      },
      "table-union"
    );
    // The only passage both sides wrote in one place is the paragraph and the item.
    expect(plan.pairs.map((pair) => [pair.ours, pair.theirs])).toEqual([["Both tables live in the shop.", "- Sharpen before the trail-sign build."]]);
    expect(resolvedContent(plan.render(new Map()))).toBe(
      page("2026-05-03", [
        table(["| Scraper | drawer 1 |"]),
        table(["| Chisels | wall rack |"]),
        "- Sharpen before the trail-sign build.",
        "Both tables live in the shop.",
      ])
    );
  });
});

describe("strategyFor", () => {
  const md = (frontmatter: string, body = "\n## Notes\n\n- one\n") => `---\n${frontmatter}---\n${body}`;
  const sides = (text: string | null) => ({ base: text, ours: text, theirs: text });

  test("derived caches and non-markdown come first, whatever the taxonomy says", () => {
    expect(strategyFor(".context-cache.jsonl", taxonomy, sides("{}\n"))).toBe("cache-union");
    expect(strategyFor("health/.asset-cache.jsonl", taxonomy, sides("{}\n"))).toBe("cache-union");
    expect(strategyFor("notes/export.csv", taxonomy, sides("a,b\n"))).toBe("code-merge");
    expect(strategyFor("CLAUDE.md", taxonomy, sides(md("type: note\n")))).toBe("code-merge");
    expect(strategyFor("AGENTS.md", taxonomy, sides("# Agents\n"))).toBe("code-merge");
  });

  test("the type's mergeStrategy wins over the file's shape", () => {
    // `type: note` is keep-both even as an `_index.md` with a Timeline.
    expect(strategyFor("projects/_index.md", taxonomy, sides(md("type: note\n", "\n## Timeline\n\n- 2026-05-01 x\n")))).toBe("keep-both");
    expect(strategyFor("me/identity.md", taxonomy, sides("# Alex\n"))).toBe("latest-wins-additive");
    expect(strategyFor("anywhere/registry.md", taxonomy, sides(md("type: index\n")))).toBe("table-union");
  });

  test("a document the taxonomy cannot place does not inherit the inbox's strategy", () => {
    // typeForPath would call this a note (the inbox type) and pick keep-both.
    expect(taxonomy.typeForPath("projects/workbench.md")).toBe("note");
    expect(strategyFor("projects/workbench.md", taxonomy, sides(md("type: project\n")))).toBe("synthesize");
  });

  test("the declared type is read from OURS, then THEIRS, then BASE", () => {
    const text = (type: string) => md(`type: ${type}\n`);
    expect(strategyFor("x/a.md", taxonomy, { base: text("index"), ours: text("identity"), theirs: text("note") })).toBe("latest-wins-additive");
    expect(strategyFor("x/a.md", taxonomy, { base: text("index"), ours: null, theirs: text("note") })).toBe("keep-both");
    expect(strategyFor("x/a.md", taxonomy, { base: text("index"), ours: text("project"), theirs: null })).toBe("table-union");
  });

  test("_index.md, then a Timeline heading on any side, then synthesize", () => {
    expect(strategyFor("projects/_index.md", taxonomy, sides(md("title: Builds\n", "\n## Timeline\n\n- x\n")))).toBe("table-union");
    expect(
      strategyFor("projects/bench.md", taxonomy, { base: md("title: b\n"), ours: md("title: b\n"), theirs: md("title: b\n", "\n## Timeline\n\n- 2026-05-01 x\n") })
    ).toBe("timeline-append");
    // A `# Timeline` line inside a fence is code, not a heading.
    expect(strategyFor("projects/bench.md", taxonomy, sides(md("title: b\n", "\n```\n# Timeline\n```\n")))).toBe("synthesize");
    expect(strategyFor("context/current-focus.md", taxonomy, sides(md("type: context\n")))).toBe("synthesize");
  });

  test("a user override sets the strategy of a type", () => {
    const custom = buildTaxonomy({ user: { taxonomy: { types: { project: { dir: "projects", mergeStrategy: "timeline-append" } } } } as never });
    expect(strategyFor("projects/bench.md", custom, sides(md("title: b\n")))).toBe("timeline-append");
  });
});

describe("config", () => {
  test("mergeStrategy accepts the strategies and nothing else", () => {
    expect(typeSpecSchema.safeParse({ dir: "projects", mergeStrategy: "table-union" }).success).toBe(true);
    expect(typeSpecSchema.safeParse({ dir: "projects", mergeStrategy: "newest" }).success).toBe(false);
  });

  test("sync.judge is jev or off", () => {
    expect(brainConfigSchema.safeParse({ sync: { judge: "off" } }).success).toBe(true);
    expect(brainConfigSchema.safeParse({ sync: { judge: "jev" } }).success).toBe(true);
    expect(brainConfigSchema.safeParse({ sync: {} }).success).toBe(true);
    expect(brainConfigSchema.safeParse({ sync: { judge: "maybe" } }).success).toBe(false);
    expect(brainConfigSchema.safeParse({ sync: { pull: true } }).success).toBe(false);
  });

  test("the core types carry their documented defaults", () => {
    expect(Object.fromEntries(Object.entries(taxonomy.types).map(([name, spec]) => [name, spec.mergeStrategy ?? null]))).toEqual({
      identity: "latest-wins-additive",
      context: null,
      note: "keep-both",
      index: "table-union",
    });
  });
});

describe("mergeFrontmatter", () => {
  const parse = (text: string) => parseDoc(text, "ours", { tables: "rows" });
  const merge = (base: string, ours: string, theirs: string) => {
    const notes: string[] = [];
    const block = mergeFrontmatter(parse(base), parse(ours), parse(theirs), notes);
    return { block, notes };
  };

  test("a date and the string it prints as are the same value", () => {
    const base = "---\nupdated: 2026-05-01\ntitle: a\n---\n";
    const ours = "---\nupdated: \"2026-05-01\"\ntitle: b\n---\n";
    const theirs = "---\nupdated: 2026-05-01\ntitle: a\nstatus: done\n---\n";
    // OURS only requoted `updated`: no conflict on it, and no note.
    expect(merge(base, ours, theirs)).toEqual({ block: "---\nupdated: \"2026-05-01\"\ntitle: b\nstatus: done\n---\n", notes: [] });
  });

  test("OURS' key order, quoting and comments survive an edit from THEIRS", () => {
    const base = "---\n# kept by hand\ntitle: 'Owl survey'\nupdated: 2026-05-01\ntags: [owl]\n---\n";
    const ours = "---\n# kept by hand\ntitle: 'Owl survey'\nupdated: 2026-05-02\ntags: [owl, dusk]\n---\n";
    const theirs = "---\nupdated: 2026-05-04\ntags: [owl, fire-road]\ntitle: 'Owl survey'\ncreated: 2026-04-30\n---\n";
    const { block, notes } = merge(base, ours, theirs);
    expect(block).toBe("---\n# kept by hand\ntitle: 'Owl survey'\nupdated: 2026-05-04\ntags: [dusk, fire-road, owl]\ncreated: 2026-04-30\n---\n");
    expect(notes).toEqual([
      "frontmatter `updated`: both sides changed it; kept the later (theirs)",
      "frontmatter `tags`: both sides changed them; kept the union",
    ]);
  });

  test("created is the earlier, a field removed on one side and changed on the other is kept", () => {
    const base = "---\ncreated: 2026-03-01\nsummary: first\n---\n";
    const ours = "---\ncreated: 2026-02-10\n---\n";
    const theirs = "---\ncreated: 2026-02-20\nsummary: second\n---\n";
    const { block, notes } = merge(base, ours, theirs);
    expect(block).toBe("---\ncreated: 2026-02-10\nsummary: second\n---\n");
    expect(notes).toContain("frontmatter `summary`: removed on our side and changed on the other; kept the changed value");
  });

  test("a date one side wrote as text that is not a date keeps OURS, with a note", () => {
    const { block, notes } = merge("---\nupdated: 2026-05-01\n---\n", "---\nupdated: 2026-05-02\n---\n", "---\nupdated: last week\n---\n");
    expect(block).toBe("---\nupdated: 2026-05-02\n---\n");
    expect(notes).toEqual(["frontmatter `updated`: both sides changed it and one is not a date; kept ours"]);
  });

  test("a value the in-place edit cannot write goes through the serializer, keys in OURS' order", () => {
    const base = "---\ntitle: Bench\nrating: 3\n---\n";
    const ours = "---\ntitle: Bench build\nrating: 3\n---\n";
    const theirs = "---\ntitle: Bench\nrating: 4\n---\n";
    const { block, notes } = merge(base, ours, theirs);
    expect(block).toBe("---\ntitle: Bench build\nrating: 4\n---\n");
    expect(notes).toEqual(["frontmatter: rewritten by the serializer; quoting and comments may differ from ours"]);
  });
});

describe("remotePath", () => {
  test("names THEIRS' copy after the first free name", () => {
    expect(remotePath("notes/owl.md")).toBe("notes/owl-remote.md");
    const taken = new Set(["notes/owl-remote.md", "notes/owl-remote-2.md"]);
    expect(remotePath("notes/owl.md", (p) => taken.has(p))).toBe("notes/owl-remote-3.md");
    expect(remotePath("notes/OWL.MD")).toBe("notes/OWL-remote.MD");
  });
});

describe("line endings", () => {
  const base = doc("2026-07-01", "# Log\n\nSaturn low in the south.\n\nClouds after ten.\n");
  const ours = base.replace("Saturn low in the south.", "Saturn low in the south, rings clear.");
  const theirs = base.replace("Clouds after ten.", "Clouds after ten, then clear.");
  const toCrlf = (text: string) => text.replace(/\n/g, "\r\n");

  test("a CRLF side merges line by line with an LF side, and the result keeps ours' LF", () => {
    const content = resolvedContent(planMerge({ path: "studies/log.md", base, ours, theirs: toCrlf(theirs) }, "synthesize").render(new Map()));
    expect(content).toContain("rings clear.");
    expect(content).toContain("then clear.");
    expect(content).not.toContain("\r");
  });

  test("a CRLF ours keeps CRLF throughout", () => {
    const content = resolvedContent(planMerge({ path: "studies/log.md", base, ours: toCrlf(ours), theirs }, "synthesize").render(new Map()));
    expect(content).toContain("rings clear.");
    expect(content).toContain("then clear.");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });
});
