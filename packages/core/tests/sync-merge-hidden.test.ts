/**
 * Changes a comparison must not hide, and inputs no walk may choke on.
 *
 * The resolver aligns passages by a key that reads them as a reader does (a
 * row by its first cell's text, a section by its heading's text) but must
 * decide "changed" on what was written: a new link target, a new heading
 * markup or a hard line break is a change even where the visible text is
 * not. And every side is a stranger's file, so a YAML alias that refers to
 * itself or a body nested thousands deep ends in `unresolved`, not a throw.
 */

import { describe, expect, test } from "bun:test";

import { mergeFrontmatter } from "../src/lib/sync/resolve/frontmatter";
import { headingTexts, parseDoc, UnparseableError } from "../src/lib/sync/resolve/markdown";
import { planMerge, type MergeOutcome } from "../src/lib/sync/resolve/plan";
import { strategyFor } from "../src/lib/sync/resolve/strategy";
import { buildTaxonomy } from "../src/lib/taxonomy";

function resolvedOf(outcome: MergeOutcome): { content: string; notes: string[] } {
  expect(outcome.status).toBe("resolved");
  if (outcome.status !== "resolved" || outcome.content === null) throw new Error("expected content");
  return { content: outcome.content, notes: outcome.notes };
}

const table = (head: string, rows: string[]) => `---\ntitle: Route index\n---\n\n${head}\n${rows.join("\n")}\n`;
const HEAD = "| Name | Link |\n|---|---|";

describe("table-union compares cells as written", () => {
  test("a new link target on one side and new link text on the other is a conflict, not a silent loss", () => {
    const base = table(HEAD, ["| ridge | [old](old) |", "| bench | kept |"]);
    const ours = table(HEAD, ["| ridge | [old](new-url) |", "| bench | kept |", "| eagle | ours |"]);
    const theirs = table(HEAD, ["| ridge | [new](old) |", "| bench | kept |", "| oak | theirs |"]);
    const { content, notes } = resolvedOf(planMerge({ path: "_index.md", base, ours, theirs }, "table-union").render(new Map()));
    expect(content).toContain("| ridge | [old](new-url) |");
    expect(content).toContain("| ridge | [new](old) |");
    expect(notes.some((note) => note.includes("both sides changed"))).toBe(true);
  });

  test("a link target only THEIRS changed is taken", () => {
    const base = table(HEAD, ["| ridge | [map](old) |", "| bench | a |"]);
    const ours = table(HEAD, ["| ridge | [map](old) |", "| bench | b |"]);
    const theirs = table(HEAD, ["| ridge | [map](new) |", "| bench | a |", "| eagle | c |"]);
    const { content } = resolvedOf(planMerge({ path: "_index.md", base, ours, theirs }, "table-union").render(new Map()));
    expect(content).toContain("| ridge | [map](new) |");
    expect(content).toContain("| bench | b |");
  });

  test("a duplicate key's second row and a literal `a#1` key are two rows", () => {
    const base = table(HEAD, ["| A | base |"]);
    const ours = table(HEAD, ["| A | ours |", "| A | duplicate |", "| A#1 | unique |"]);
    const theirs = table(HEAD, ["| A | theirs |"]);
    const { content } = resolvedOf(planMerge({ path: "_index.md", base, ours, theirs }, "table-union").render(new Map()));
    expect(content).toContain("| A | duplicate |");
    expect(content).toContain("| A#1 | unique |");
  });

  test("a header only THEIRS rewrote (same visible text) is taken when both changed rows", () => {
    const theirsHead = "| [Name](names.md) | Link |\n|:---|---|";
    const base = table(HEAD, ["| ridge | a |", "| bench | a |"]);
    const ours = table(HEAD, ["| ridge | b |", "| bench | a |"]);
    const theirs = table(theirsHead, ["| ridge | a |", "| bench | c |"]);
    const { content } = resolvedOf(planMerge({ path: "_index.md", base, ours, theirs }, "table-union").render(new Map()));
    expect(content).toContain(theirsHead);
    expect(content).toContain("| ridge | b |");
    expect(content).toContain("| bench | c |");
  });
});

describe("synthesize compares sections and blocks as written", () => {
  const doc = (heading: string, one: string, two: string) => `---\ntitle: Plan\n---\n\n${heading}\n\n${one}\n\n${two}\n`;

  test("a heading link only THEIRS changed survives OURS' edit to the section", () => {
    const base = doc("## [Plan](old.md)", "First.", "Second.");
    const ours = doc("## [Plan](old.md)", "First, revised.", "Second.");
    const theirs = doc("## [Plan](new.md)", "First.", "Second, revised.");
    const { content } = resolvedOf(planMerge({ path: "notes/plan.md", base, ours, theirs }, "synthesize").render(new Map()));
    expect(content).toContain("## [Plan](new.md)");
    expect(content).toContain("First, revised.");
    expect(content).toContain("Second, revised.");
  });

  test("the same heading added on both sides in different case keeps ours, with a note", () => {
    const base = "---\ntitle: Plan\n---\n\nIntro.\n";
    const ours = `${base}\n## Ideas\n\nOak bench.\n`;
    const theirs = `${base}\n## IDEAS\n\nRidge route.\n`;
    const { content, notes } = resolvedOf(planMerge({ path: "notes/plan.md", base, ours, theirs }, "synthesize").render(new Map()));
    expect(content).toContain("## Ideas");
    expect(notes).toContain('section "Ideas": both sides wrote the heading differently; kept ours: "## Ideas" / "## IDEAS"');
  });

  test("a hard line break only THEIRS added survives OURS' edit elsewhere", () => {
    const base = doc("## Log", "Saturn low.\nRings clear.", "Clouds later.");
    const ours = doc("## Log", "Saturn low.\nRings clear.", "Clouds later, then rain.");
    const theirs = doc("## Log", "Saturn low.  \nRings clear.", "Clouds later.");
    const { content } = resolvedOf(planMerge({ path: "notes/log.md", base, ours, theirs }, "synthesize").render(new Map()));
    expect(content).toContain("Saturn low.  \nRings clear.");
    expect(content).toContain("Clouds later, then rain.");
  });

  test("a hard line break only THEIRS added in another section survives", () => {
    const base = "---\ntitle: Log\n---\n\n## One\n\nSaturn low.\nRings clear.\n\n## Two\n\nClouds.\n";
    const ours = base.replace("Clouds.", "Clouds, then rain.");
    const theirs = base.replace("Saturn low.\n", "Saturn low.  \n");
    const { content } = resolvedOf(planMerge({ path: "notes/log.md", base, ours, theirs }, "synthesize").render(new Map()));
    expect(content).toContain("Saturn low.  \nRings clear.");
    expect(content).toContain("Clouds, then rain.");
  });
});

describe("frontmatter comparison", () => {
  const parse = (text: string) => parseDoc(text, "ours", { tables: "rows" });

  test("`.inf` is not `null`: both sides changing a null field is a conflict", () => {
    const notes: string[] = [];
    const block = mergeFrontmatter(parse("---\nv: null\n---\n"), parse("---\nv: .inf\n---\n"), parse("---\nv: 5\n---\n"), notes);
    expect(notes).toContain("frontmatter `v`: both sides changed it; kept ours");
    expect(block).toBe("---\nv: .inf\n---\n");
  });
});

describe("structures no walk can finish are unresolved, never a throw", () => {
  const withFm = (title: string, extra: string) => `---\ntitle: ${title}\n${extra}---\n\nBody.\n`;

  test("a YAML alias that contains itself", () => {
    const cyclic = "x: &x [*x]\n";
    const run = () =>
      planMerge({ path: "notes/a.md", base: withFm("a", cyclic), ours: withFm("b", cyclic), theirs: withFm("c", cyclic) }, "synthesize").render(new Map());
    expect(run).not.toThrow();
    const outcome = run();
    expect(outcome).toEqual({ status: "unresolved", reason: "unparseable: base: frontmatter refers to itself through a YAML alias" });
  });

  test("aliases of aliases that expand past the value budget", () => {
    // Nine levels of ten aliases each: a billion values from a few hundred bytes.
    let yaml = "l0: &l0 [a, a, a, a, a, a, a, a, a, a]\n";
    for (let i = 1; i <= 9; i++) yaml += `l${i}: &l${i} [${Array.from({ length: 10 }, () => `*l${i - 1}`).join(", ")}]\n`;
    const outcome = planMerge({ path: "notes/a.md", base: withFm("a", yaml), ours: withFm("b", yaml), theirs: withFm("c", yaml) }, "synthesize").render(
      new Map()
    );
    expect(outcome.status).toBe("unresolved");
    expect(outcome.status === "unresolved" && outcome.reason).toContain("through YAML aliases");
  });

  test("frontmatter nested past the depth limit", () => {
    const deep = `y: ${"[".repeat(200)}${"]".repeat(200)}\n`;
    const outcome = planMerge({ path: "notes/a.md", base: withFm("a", deep), ours: withFm("b", deep), theirs: withFm("c", deep) }, "synthesize").render(
      new Map()
    );
    expect(outcome).toEqual({ status: "unresolved", reason: "unparseable: base: frontmatter nests deeper than 64 levels" });
  });

  test("a body nested deeper than the parser can recurse", () => {
    const deep = `Intro.\n\n${"> ".repeat(40_000)}deep\n`;
    const run = () => planMerge({ path: "notes/a.md", base: "Intro.\n", ours: deep, theirs: "Intro, revised.\n" }, "synthesize").render(new Map());
    expect(run).not.toThrow();
    expect(run()).toEqual({ status: "unresolved", reason: "unparseable: ours: the body nests too deeply to parse" });
    // The strategy's Timeline probe reads the same body: it must reach the parser, and survive it.
    expect(() => headingTexts(deep)).toThrow(UnparseableError);
    const choose = () => strategyFor("projects/bench.md", buildTaxonomy({}), { base: "Intro.\n", ours: deep, theirs: null });
    expect(choose).not.toThrow();
    expect(choose()).toBe("synthesize");
  }, 60_000);
});
