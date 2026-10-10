/**
 * `assembleContext` (#370): fills its budget greedily, keeps identity and
 * current focus whole or cuts them at a paragraph boundary, never repeats
 * them as search hits, and emits no FTS5 highlight markers or stray
 * headings. Corpus tests index a temp copy of fixtures/corpus in-process;
 * the unit tests build a small in-memory index by hand.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { fromMarkdown } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { initContext, type BrainContext } from "../src/lib/context";
import { assembleContext, emptyAssembleReport, estimateTokens } from "../src/lib/context-assembler";
import { openDatabase } from "../src/lib/db";
import { topLevelBlocks } from "../src/lib/document-parts";
import { hybridSearch } from "../src/lib/search-engine";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";

const CORE_ROOT = resolve(import.meta.dir, "..");
const temps: string[] = [];
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

describe("over fixtures/corpus", () => {
  let ctx: BrainContext;
  let db: Database;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-context-corpus-"));
    temps.push(root);
    cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
    // The fixture's brain.config.ts imports @schlessera/brain.
    symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
    ctx = await initContext({ root });
    db = openDatabase(ctx.dbPath);
    await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
  });

  afterAll(() => db?.close());

  const assemble = (query: string, maxTokens: number) => assembleContext(db, ctx, { query, maxTokens });

  test("includes identity whole when it fits, past its first 500 characters", async () => {
    const identity = parseFrontmatter(readFileSync(join(ctx.root, "me/identity.md"), "utf8")).content;
    // The premise: the heading sits past the 500 characters main kept.
    expect(identity.indexOf("## How to Work With Odysseus")).toBeGreaterThan(500);
    expect(await assemble("navigation", 4000)).toContain("## How to Work With Odysseus");
  });

  // "navigation" matches too little of the corpus to outgrow 2000 tokens, so a
  // broader query shows the budget being used.
  const BROAD = "raft star guide knee sail sleep eagle pine navigation";

  test("a larger budget yields strictly more, and neither exceeds its budget", async () => {
    const small = await assemble(BROAD, 2000);
    const large = await assemble(BROAD, 8000);
    expect(large.length).toBeGreaterThan(small.length);
    expect(estimateTokens(small)).toBeLessThanOrEqual(2000);
    expect(estimateTokens(large)).toBeLessThanOrEqual(8000);
    expect(estimateTokens(await assemble("navigation", 4000))).toBeLessThanOrEqual(4000);
  });

  test("a budget with more material than room is mostly used", async () => {
    // Floor, not target: greedy fill leaves only what no remaining hit fits.
    expect(estimateTokens(await assemble(BROAD, 2000))).toBeGreaterThan(1600);
  });

  test("includes current focus whole when it fits", async () => {
    const { content, data } = parseFrontmatter(readFileSync(join(ctx.root, "context/current-focus.md"), "utf8"));
    const focus = content.trim();
    // The premise: more than the 800 characters main kept.
    expect(focus.length).toBeGreaterThan(800);
    // Summary first, then the body whole.
    expect(await assemble("navigation", 4000)).toContain(`## Current Focus\n${data.summary}\n\n${focus}`);
  });

  test("carries no FTS5 highlight markers", async () => {
    const out = await assemble("navigation", 4000);
    // The premise: the query hits the full-text lane, whose snippets carry them.
    expect(out).toContain("### ");
    expect(out).not.toContain(">>>");
    expect(out).not.toContain("<<<");
  });

  test("identity and current focus each appear once, not again as a search hit", async () => {
    const out = await assemble("navigation", 4000);
    expect(out.split("\n").filter((l) => l === "## Identity")).toHaveLength(1);
    expect(out.split("\n").filter((l) => l === "## Current Focus")).toHaveLength(1);
    expect(out).not.toContain("(me/identity.md)");
    expect(out).not.toContain("(context/current-focus.md)");
  });

  test("an identity that does not fit leads with its summary, with a pointer to the file", async () => {
    // The corpus identity has no text before its first "##" heading, and its
    // first section does not fit in 200 tokens: what leads is the summary.
    const out = await assembleContext(db, ctx, { query: "navigation", maxTokens: 200, includeCurrentFocus: false });
    expect(out.startsWith(
      "## Identity\nKing of Ithaca, on Ogygia after ten years returning from Troy\n\n(truncated — brain read me/identity.md)"
    )).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
  });

  // #518: identity and focus used to take as much as fitted before any hit,
  // so a budget where the focus fits whole (550) held fewer hits than a
  // smaller one where it was cut (500). Now they are placed in their minimal
  // form, hits against the rest, and only what is left grows them.
  // A known limit, accepted on #522: the hit fill stays greedy (#370), so an
  // early hit too big for a small budget can fit a larger one and displace a
  // later, smaller hit. This sweep guards that no such case occurs here.
  test("a larger budget never drops a search hit, and every budget is kept", async () => {
    const now = new Date("2026-07-12");
    for (const query of ["Odysseus", "knee injury"]) {
      let previous: string[] = [];
      const dropped: string[] = [];
      const over: number[] = [];
      const missing: number[] = [];
      for (let budget = 200; budget <= 2000; budget += 10) {
        const report = emptyAssembleReport();
        const out = await assembleContext(db, ctx, { query, maxTokens: budget, now, report });
        for (const path of previous) if (!report.results.includes(path)) dropped.push(`${path} at ${budget}`);
        if (estimateTokens(out) > budget) over.push(budget);
        if (!report.identity || !report.focus) missing.push(budget);
        previous = report.results;
      }
      // The sweep is not vacuous: hits arrive as the budget grows.
      expect(previous.length).toBeGreaterThan(1);
      expect({ query, dropped }).toEqual({ query, dropped: [] });
      expect({ query, over }).toEqual({ query, over: [] });
      expect({ query, missing }).toEqual({ query, missing: [] });
    }
  });

  test("with room for them and every hit, identity and focus are whole again", async () => {
    const report = emptyAssembleReport();
    const out = await assembleContext(db, ctx, { query: "Odysseus", maxTokens: 2000, now: new Date("2026-07-12"), report });
    // The premise: at 2000 tokens "Odysseus" gets all of its hits.
    expect(report.results.length).toBe(4);
    expect(out).not.toContain("(truncated — brain read");
    expect(out).toContain("## How to Work With Odysseus");
  });
});

describe("neighbours over fixtures/corpus", () => {
  let ctx: BrainContext;
  let db: Database;
  // "auger bulwarks" matches only the raft plan, so its directory index
  // and its links reach the output only as neighbours.
  const QUERY = "auger bulwarks";
  const PLAN = "projects/active/raft/plan.md";
  const INDEX_LINE = "- Raft Build — Index (projects/active/raft/_index.md) — Registry for the Ogygia raft — plan, status and overview";

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-context-neighbours-"));
    temps.push(root);
    cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
    symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
    // A link from the plan to the archived build, which must never be offered.
    appendFileSync(join(root, PLAN), "\nThe earlier bench: [[one-old-build]].\n");
    ctx = await initContext({ root });
    db = openDatabase(ctx.dbPath);
    await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
  });

  afterAll(() => db?.close());

  const assemble = (maxTokens: number) =>
    assembleContext(db, ctx, { query: QUERY, maxTokens, includeIdentity: false, includeCurrentFocus: false });

  test("with budget left, the top hit's directory index follows as a related line", async () => {
    const out = await assemble(4000);
    // The premise: the plan is the only search hit.
    expect(out.split("\n").filter((line) => line.startsWith("### ") && line !== "### Related")).toHaveLength(1);
    expect(out).toContain(`(${PLAN})`);
    expect(out).toContain(`### Related\n${INDEX_LINE}`);
  });

  // A hit's form depends on the budget since #373 (its section, capped at
  // 40% of the budget, or its snippet), so these walk the budget up rather
  // than derive a smaller one from a larger run.
  async function firstBudget(from: number, until: (out: string) => boolean): Promise<{ budget: number; out: string }> {
    for (let budget = from; budget < 2000; budget++) {
      const out = await assemble(budget);
      if (until(out)) return { budget, out };
    }
    throw new Error("no budget up to 2000 satisfied the condition");
  }

  test("related lines go in while they fit, the directory index first", async () => {
    // Since a hit may take at most 40% of the budget (#373), the first budget
    // the plan fits in leaves room for more than one line, so this checks the
    // order and the prefix rule rather than a one-line budget.
    const related = (out: string) => out.split("\n### Related\n")[1]?.split("\n") ?? [];
    const { budget, out } = await firstBudget(1, (o) => o.includes("### Related"));
    expect(out).toContain(`(${PLAN})`);
    expect(related(out)[0]).toBe(INDEX_LINE);
    const full = related(await assemble(4000));
    for (const b of [budget, budget + 25, budget + 50, budget + 100]) {
      const lines = related(await assemble(b));
      expect({ b, lines }).toEqual({ b, lines: full.slice(0, lines.length) });
    }
  });

  test("an archived neighbour is never offered", async () => {
    // The premise: the plan links to the archived build.
    const linked = db.prepare(
      "SELECT d.path FROM links l JOIN documents d ON d.id = l.target_id WHERE l.source_id = (SELECT id FROM documents WHERE path = ?)"
    ).all(PLAN) as { path: string }[];
    expect(linked.map((r) => r.path)).toContain("projects/archive/one-old-build.md");
    expect(await assemble(4000)).not.toContain("one-old-build.md");
  });

  test("no document appears twice", async () => {
    const out = await assemble(4000);
    const cited = [...out.matchAll(/\(([^()\s]+\.md)\)/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(2);
    expect(cited).toEqual([...new Set(cited)]);
  });

  test("no budget is exceeded with neighbours on", async () => {
    const over: number[] = [];
    let withRelated = 0;
    for (let budget = 60; budget <= 1200; budget += 7) {
      const out = await assemble(budget);
      if (out.includes("### Related")) withRelated++;
      if (estimateTokens(out) > budget) over.push(budget);
    }
    expect(withRelated).toBeGreaterThan(0);
    expect(over).toEqual([]);
  });
});

describe("over a hand-built index", () => {
  let dir: string;
  let db: Database;
  let ctx: BrainContext;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-context-unit-"));
    temps.push(dir);
    db = openDatabase(":memory:");
    const taxonomy = buildTaxonomy({});
    ctx = { root: dir, dbPath: ":memory:", config: null, configPath: null, modules: [], taxonomy };
  });

  afterAll(() => db?.close());

  let nextId = 1;
  function addDoc(path: string, title: string, content: string, summary: string | null = null) {
    const id = nextId++;
    db.run("INSERT INTO documents(id,path,title,type,status,summary,created,updated,content,indexed_at) VALUES (?,?,?,'note','active',?,'2026-01-01','2026-01-01',?,'2026-01-01')", [id, path, title, summary, content]);
    db.run("INSERT INTO documents_fts(rowid,title,summary,content,tags) VALUES (?,?,'',?,'')", [id, title, content]);
    // Its body is chunked, as the indexer would.
    db.run("INSERT INTO chunks(document_id,chunk_index,heading,content,token_estimate) VALUES (?,0,'',?,1)", [id, content]);
  }

  test("a hit too large for the budget is skipped and the next one that fits is included", async () => {
    addDoc("notes/huge.md", `Lantern ${"very long title ".repeat(150)}`, "lantern lantern lantern lantern");
    addDoc("notes/small.md", "Small", "a lantern");
    // The premise: the huge hit is ranked first and alone exceeds the budget.
    const { results } = await hybridSearch(db, { query: "lantern", limit: 2 }, { taxonomy: ctx.taxonomy });
    expect(results.map((r) => r.path)).toEqual(["notes/huge.md", "notes/small.md"]);
    expect(estimateTokens(results[0]!.title)).toBeGreaterThan(300);

    const out = await assembleContext(db, ctx, { query: "lantern", maxTokens: 300, includeIdentity: false, includeCurrentFocus: false });
    expect(out).not.toContain("notes/huge.md");
    expect(out).toContain("(notes/small.md)");
  });

  test("hit bodies are contained: the parsed output has only the hit headings as blocks", async () => {
    // Each body starts, or FTS cuts it into, a Markdown block: a setext
    // heading, an unclosed fence, an unclosed HTML comment, a quote, a list.
    addDoc("notes/setext.md", "Setext", "beacon setext\n===\nmore text");
    addDoc("notes/fence.md", "Fence", "beacon fence\n```\nconst x = 1;");
    addDoc("notes/comment.md", "Comment", "<!-- beacon comment that never closes");
    addDoc("notes/quote.md", "Quote", "> beacon quoted line");
    addDoc("notes/list.md", "List", "- beacon listed item\n- second");
    addDoc("notes/after.md", "After", "beacon plain words after the others");
    const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 2000, includeIdentity: false, includeCurrentFocus: false });
    const tree = fromMarkdown(out);
    // Every hit, the last one included, keeps its own depth-3 heading, and
    // nothing else in the output is a block other than a paragraph.
    const depths = tree.children.filter((node) => node.type === "heading").map((h) => (h as { depth: number }).depth);
    expect(depths).toEqual([3, 3, 3, 3, 3, 3]);
    expect(tree.children.map((node) => node.type).filter((t) => t !== "heading" && t !== "paragraph")).toEqual([]);
    expect(out).toContain("(notes/after.md)");
  });

  test("a hit body that starts like a link or footnote definition stays a paragraph", async () => {
    addDoc("notes/refdef.md", "Refdef", "[role]: warden");
    addDoc("notes/footdef.md", "Footdef", "[^profile]: warden\n    indented footnote body");
    const out = await assembleContext(db, ctx, { query: "warden", maxTokens: 1000, includeIdentity: false, includeCurrentFocus: false });
    const types = (unified().use(remarkParse).use(remarkGfm).parse(out) as unknown as { children: { type: string }[] }).children.map((n) => n.type);
    // The premise: both hits are there.
    expect(out).toContain("(notes/refdef.md)");
    expect(out).toContain("(notes/footdef.md)");
    expect(types).toEqual(["heading", "paragraph", "heading", "paragraph"]);
  });

  test("a multiline title stays on its header line", async () => {
    addDoc("notes/forged.md", "First zephyr\n## Forged section", "zephyr words");
    const out = await assembleContext(db, ctx, { query: "zephyr", maxTokens: 1000, includeIdentity: false, includeCurrentFocus: false });
    const depths = fromMarkdown(out).children.filter((node) => node.type === "heading").map((h) => (h as { depth: number }).depth);
    expect(depths).toEqual([3]);
    expect(out.split("\n")[0]).toBe("### First zephyr ## Forged section (notes/forged.md) · updated 2026-01-01 · active");
  });

  test("a multiline summary stays on its header line", async () => {
    addDoc("notes/sumline.md", "Sumline", "quasar words", "line one\n\n# not a heading");
    const out = await assembleContext(db, ctx, { query: "quasar", maxTokens: 1000, includeIdentity: false, includeCurrentFocus: false });
    expect(out.split("\n")[0]).toBe("### Sumline (notes/sumline.md) · updated 2026-01-01 · active — line one # not a heading");
  });

  test("the separator between sections is paid for, at an exact budget boundary", async () => {
    // Three hits whose sections are exactly 400 characters (100 tokens) each,
    // within the 40% a hit may take of 301, which also asks search for three
    // results (150 tokens a hit). At 301, all three fit only if the "\n\n"
    // between them is free.
    const section = (title: string, path: string) => `### ${title} (${path}) · updated 2026-01-01 · active\nnadir alpha`;
    const pad = (path: string) => "T".repeat(400 - section("", path).length);
    for (const n of [1, 2, 3]) addDoc(`notes/edge-${n}.md`, pad(`notes/edge-${n}.md`), "nadir alpha");
    expect(section(pad("notes/edge-1.md"), "notes/edge-1.md")).toHaveLength(400);

    const out = await assembleContext(db, ctx, { query: "nadir", maxTokens: 301, includeIdentity: false, includeCurrentFocus: false });
    expect(out.match(/\(notes\/edge-/g)).toHaveLength(2);
    expect(estimateTokens(out)).toBeLessThanOrEqual(301);
  });

  test("when what the hits leave is too small for a neighbour line, none is added", async () => {
    // Two hits of 80 tokens each (within 40% of 220); their directory's index
    // is a neighbour whose line takes more than the 59 tokens they leave.
    const section = (title: string, path: string) => `### ${title} (${path}) · updated 2026-01-01 · active\nquasar alpha`;
    const pad = (path: string) => "T".repeat(320 - section("", path).length);
    for (const n of [1, 2]) addDoc(`notes/sky-${n}.md`, pad(`notes/sky-${n}.md`), "quasar alpha");
    addDoc("notes/_index.md", `Notes index ${"with a long title ".repeat(20)}`, "the notes");
    const assembleAt = (maxTokens: number) =>
      assembleContext(db, ctx, { query: "quasar", maxTokens, includeIdentity: false, includeCurrentFocus: false });
    const tight = await assembleAt(220);
    expect(tight.match(/\(notes\/sky-/g)).toHaveLength(2);
    expect(tight).not.toContain("### Related");
    // The control: with room left, the index is offered.
    expect(await assembleAt(400)).toContain("### Related\n- Notes index");
  });

  test("each hit's header is one line: title, path, updated date, status and summary", async () => {
    addDoc("notes/summarised.md", "Summarised", "a harbour note", "Where the harbour ferry leaves from");
    const out = await assembleContext(db, ctx, { query: "harbour", maxTokens: 1000, includeIdentity: false, includeCurrentFocus: false });
    expect(out.split("\n")).toContain(
      "### Summarised (notes/summarised.md) · updated 2026-01-01 · active — Where the harbour ferry leaves from"
    );
  });

  describe("identity cut at a block boundary", () => {
    const LONG = "word ".repeat(400).trim();
    const cases: [string, string][] = [
      ["a CRLF blank line", `Short complete sentence.\r\n\r\n${LONG}`],
      ["a whitespace-only blank line", `Short complete sentence.\n   \n${LONG}`],
      ["a heading with no blank line before it", `Short complete sentence.\n## Next\n${LONG}`],
    ];
    for (const [name, body] of cases) {
      test(`recognises ${name}`, async () => {
        mkdirSync(join(dir, "me"), { recursive: true });
        writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\n${body}\n`);
        const out = await assembleContext(db, ctx, { query: "", maxTokens: 100, includeCurrentFocus: false });
        expect(out).toBe("## Identity\nShort complete sentence.\n\n(truncated — brain read me/identity.md)");
      });
    }

    test("never cuts inside a fenced block", async () => {
      // A blank line inside the fence would fit as a cut, and leave it open.
      mkdirSync(join(dir, "me"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\nIntro.\n\n` + "```\ncode\n\n" + `${LONG}\n` + "```\n");
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 100, includeCurrentFocus: false });
      expect(out).toBe("## Identity\nIntro.\n\n(truncated — brain read me/identity.md)");
    });

    test("while the lead is cut no hit is placed, so none is dropped as the cut grows (#518)", async () => {
      // Twelve short paragraphs: the cut keeps a few more with each larger
      // budget, so the room it leaves behind rises and falls.
      const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${"steady prose about the preserve ".repeat(6).trim()}.`);
      mkdirSync(join(dir, "me"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\n${paragraphs.join("\n\n")}\n`);
      addDoc("notes/quiver.md", "Quiver", "quiver");
      let previous: string[] = [];
      const dropped: number[] = [];
      const hitWhileCut: number[] = [];
      let firstHit: number | null = null;
      for (let budget = 60; budget <= 1200; budget += 5) {
        const report = emptyAssembleReport();
        const out = await assembleContext(db, ctx, { query: "quiver", maxTokens: budget, includeCurrentFocus: false, report });
        if (previous.some((path) => !report.results.includes(path))) dropped.push(budget);
        if (!out.includes(paragraphs[11]!) && report.results.length > 0) hitWhileCut.push(budget);
        if (firstHit === null && report.results.length > 0) firstHit = budget;
        previous = report.results;
      }
      // The premise: the hit does arrive once the whole lead fits.
      expect(firstHit).not.toBeNull();
      expect(dropped).toEqual([]);
      expect(hitWhileCut).toEqual([]);
    });
  });

  test("neighbour titles and summaries cannot open a block of their own", async () => {
    // A hit whose directory index and linked documents carry block syntax
    // at the start of their titles, and multiline titles and summaries.
    addDoc("orbit/hub.md", "Hub", "orbit orbit orbit");
    addDoc("orbit/_index.md", "# Index heading", "directory notes", "first line\n\n# not a heading");
    const linkedDocs: [string, string, string | null][] = [
      ["orbit/fence.md", "```fenced title", null],
      ["orbit/quote.md", "> quoted title", "a summary"],
      ["orbit/list.md", "- listed title", null],
      ["orbit/multi.md", "First line\n## Forged section", "one\n\n> two"],
      ["orbit/refdef.md", "[role]: sailor", null],
    ];
    for (const [path, title, summary] of linkedDocs) addDoc(path, title, "unrelated words", summary);
    const hubId = (db.prepare("SELECT id FROM documents WHERE path = 'orbit/hub.md'").get() as { id: number }).id;
    for (const [path] of linkedDocs) {
      const target = db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number };
      db.run("INSERT INTO links(source_id, target, target_id) VALUES (?,?,?)", [hubId, path, target.id]);
    }

    const out = await assembleContext(db, ctx, { query: "orbit", maxTokens: 2000, includeIdentity: false, includeCurrentFocus: false });
    const related = out.split("### Related\n")[1]!;
    // The premise: the directory index and all four linked docs are offered.
    for (const path of ["orbit/_index.md", ...linkedDocs.map(([p]) => p)]) expect(related).toContain(`(${path})`);
    const tree = fromMarkdown(out);
    // Only the hit heading and "### Related" are headings; the related lines
    // form one list whose five items are each a single paragraph.
    const headings = tree.children.filter((node) => node.type === "heading").map((h) => (h as { depth: number }).depth);
    expect(headings).toEqual([3, 3]);
    const list = tree.children.at(-1) as { type: string; children: { children: { type: string }[] }[] };
    expect(list.type).toBe("list");
    expect(list.children.map((item) => item.children.map((child) => child.type))).toEqual(
      Array.from({ length: 6 }, () => ["paragraph"])
    );
  });

  describe("a separator is charged with the text it precedes (#522)", () => {
    // `estimateTokens("\n\n" + text)` can be one token less than the two
    // rounded apart, so a form that fits by push's own charge must be taken.
    const write = (identity: string, focus: string) => {
      mkdirSync(join(dir, "me"), { recursive: true });
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\n${identity}\n`);
      writeFileSync(join(dir, "context/current-focus.md"), `---\ntype: context\n---\n${focus}\n`);
    };
    afterAll(() => rmSync(join(dir, "context/current-focus.md"), { force: true }));
    const FOCUS = `Short.\n\n${"L".repeat(158)}\n\n## Long\n${"X".repeat(1000)}`;

    test("a focus that fits after a cut identity is included (budget 18)", async () => {
      write("A".repeat(1000), "F");
      const report = emptyAssembleReport();
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 18, report });
      expect(report.focus).toBe("context/current-focus.md");
      expect(out.endsWith("## Current Focus\nF")).toBe(true);
      expect(estimateTokens(out)).toBeLessThanOrEqual(18);
    });

    test("both documents grow whole when they fit exactly (budget 303)", async () => {
      write("I", FOCUS);
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 303 });
      expect(out).toBe(`## Identity\nI\n\n## Current Focus\n${FOCUS}`);
      expect(estimateTokens(out)).toBeLessThanOrEqual(303);
    });

    test("growth never shortens a placed form (budget 63)", async () => {
      write("I", FOCUS);
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 63 });
      // The premise: both minimal forms fit, and the focus lead is one of them.
      const minimal = `## Identity\nI\n\n## Current Focus\nShort.\n\n${"L".repeat(158)}\n\n(truncated — brain read context/current-focus.md)`;
      expect(estimateTokens(minimal)).toBeLessThanOrEqual(63);
      expect(out).toBe(minimal);
    });
  });

  describe("identity leads with its lead, then whole sections", () => {
    // A 300-character lead, then a 2,000-character section made of short
    // paragraphs (each would fit on its own), then a second section.
    const LEAD = `${"Sailor waiting on Ogygia; speaks two languages; reach me by the phone. ".repeat(4).trim()}`;
    const SECTION = `## History\n\n${Array.from({ length: 20 }, (_, i) => `Year ${i}: ${"ninety-some characters of old history ".repeat(3).trim()}.`).join("\n\n")}`;
    const LATER = `## Later\n\n${"more words ".repeat(300).trim()}`;
    const write = () => {
      mkdirSync(join(dir, "me"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\n${LEAD}\n\n${SECTION}\n\n${LATER}\n`);
    };

    test("the premise: lead and section have the sizes the case is about", () => {
      expect(LEAD.length).toBeGreaterThanOrEqual(280);
      expect(LEAD.length).toBeLessThanOrEqual(300);
      expect(SECTION.length).toBeGreaterThan(1900);
    });

    test("a budget of 300 takes the whole lead and none of the section", async () => {
      write();
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 300, includeCurrentFocus: false });
      expect(out).toBe(`## Identity\n${LEAD}\n\n(truncated — brain read me/identity.md)`);
    });

    test("a heading inside a fenced block does not end the lead", async () => {
      mkdirSync(join(dir, "me"), { recursive: true });
      const lead = `${LEAD}\n\n` + "```\n## inside the fence\n```";
      writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\n---\n${lead}\n\n${SECTION}\n`);
      const expected = `## Identity\n${lead}\n\n(truncated — brain read me/identity.md)`;
      const out = await assembleContext(db, ctx, { query: "", maxTokens: estimateTokens(expected), includeCurrentFocus: false });
      expect(out).toBe(expected);
    });

    test("a budget with room for the lead and the section takes the section whole", async () => {
      write();
      const budget = estimateTokens(`## Identity\n${LEAD}\n\n${SECTION}\n\n(truncated — brain read me/identity.md)`);
      const out = await assembleContext(db, ctx, { query: "", maxTokens: budget, includeCurrentFocus: false });
      expect(out).toBe(`## Identity\n${LEAD}\n\n${SECTION}\n\n(truncated — brain read me/identity.md)`);
    });
  });

  describe("identity split by parsed structure", () => {
    const MARKER = "(truncated — brain read me/identity.md)";
    const LONG = `${"long words of old history ".repeat(60).trim()}.`;
    const identity = async (text: string, maxTokens: number) => {
      mkdirSync(join(dir, "me"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), text);
      return assembleContext(db, ctx, { query: "", maxTokens, includeCurrentFocus: false });
    };
    const doc = (body: string, summary?: string) =>
      `---\ntype: identity\n${summary ? `summary: "${summary}"\n` : ""}---\n${body}\n`;

    test("a four-backtick fence holding ~~~ and a ## line is one block, never left open", async () => {
      const out = await identity(doc(`Intro.\n\n${"````"}\n~~~\n## inside code\n${"````"}\n\n${LONG}\n\n## History\n\n${LONG}`), 100);
      const tree = fromMarkdown(out);
      const last = tree.children.at(-1) as { type: string; children?: { value?: string }[] };
      expect(last.type).toBe("paragraph");
      expect(last.children?.[0]?.value).toBe(MARKER);
      expect(out).toContain("## inside code\n````");
    });

    test("a ## line indented inside a list does not start a section", async () => {
      const lead = "Intro.\n\n- an item\n  ## not a section\n\nMore lead.";
      const out = await identity(doc(`${lead}\n\n## Real\n\n${LONG}`), 100);
      expect(out).toBe(`## Identity\n${lead}\n\n${MARKER}`);
    });

    test("a setext ## heading starts a section, so none of it is taken partially", async () => {
      const out = await identity(doc(`Intro.\n\nHistory\n-------\n\n${"A short old paragraph. ".repeat(3)}\n\n${LONG}`), 100);
      expect(out).toBe(`## Identity\nIntro.\n\n${MARKER}`);
    });

    test("a # heading stays in the lead, so an overflowing lead is cut after it", async () => {
      const out = await identity(doc(`Intro.\n\n# Roles\n\nCurrent sailor.\n\n${LONG}\n\n## History\n\n${LONG}`), 100);
      expect(out).toBe(`## Identity\nIntro.\n\n# Roles\n\nCurrent sailor.\n\n${MARKER}`);
    });

    test("the summary leads at every budget", async () => {
      const text = doc(`Intro.\n\n${"word ".repeat(80).trim()}`, "HOT SUMMARY");
      for (const budget of [40, 400, 4000]) {
        const out = await identity(text, budget);
        expect({ budget, lead: out.split("\n")[1] }).toEqual({ budget, lead: "HOT SUMMARY" });
      }
    });

    test("a document with only a summary still contributes it", async () => {
      expect(await identity(doc("", "HOT SUMMARY"), 400)).toBe("## Identity\nHOT SUMMARY");
    });

    // GFM, so a footnote definition is recognised too.
    const blockTypes = (out: string) =>
      (unified().use(remarkParse).use(remarkGfm).parse(out) as unknown as { children: { type: string; depth?: number }[] })
        .children.map((node) => node.type === "heading" ? `h${node.depth}` : node.type);

    test("a summary that looks like a fence opens no block, when the document fits whole", async () => {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "context/current-focus.md"), "---\ntype: context\n---\nCurrent priority.\n");
      mkdirSync(join(dir, "me"), { recursive: true });
      writeFileSync(join(dir, "me/identity.md"), doc("Intro.", "~~~"));
      const out = await assembleContext(db, ctx, { query: "", maxTokens: 400 });
      // Identity (summary, body), then focus: nothing swallowed by a code block.
      expect(blockTypes(out)).toEqual(["h2", "paragraph", "paragraph", "h2", "paragraph"]);
      expect(out).toContain("Current priority.");
    });

    test("a summary that looks like a fence opens no block, when the document is cut", async () => {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "context/current-focus.md"), "---\ntype: context\n---\nCurrent priority.\n");
      const out = await identity(doc(`Intro.\n\n${LONG}\n\n## History\n\n${LONG}`, "~~~"), 100);
      expect(blockTypes(out)).toEqual(["h2", "paragraph", "paragraph", "paragraph"]);
      expect(out.endsWith(MARKER)).toBe(true);
    });

    for (const summary of ["[role]: sailor", "[^profile]: sailor\n    indented footnote body"]) {
      test(`a summary like ${JSON.stringify(summary.split("\n")[0])} opens no definition, when the document fits whole`, async () => {
        mkdirSync(join(dir, "me"), { recursive: true });
        writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\nsummary: ${JSON.stringify(summary)}\n---\nIntro.\n`);
        const out = await assembleContext(db, ctx, { query: "", maxTokens: 400, includeCurrentFocus: false });
        expect(blockTypes(out)).toEqual(["h2", "paragraph", "paragraph"]);
      });

      test(`a summary like ${JSON.stringify(summary.split("\n")[0])} opens no definition, when the document is cut`, async () => {
        mkdirSync(join(dir, "me"), { recursive: true });
        writeFileSync(join(dir, "me/identity.md"), `---\ntype: identity\nsummary: ${JSON.stringify(summary)}\n---\nIntro.\n\n${LONG}\n\n## History\n\n${LONG}\n`);
        const out = await assembleContext(db, ctx, { query: "", maxTokens: 100, includeCurrentFocus: false });
        expect(blockTypes(out)).toEqual(["h2", "paragraph", "paragraph", "paragraph"]);
        expect(out.endsWith(MARKER)).toBe(true);
      });
    }

    test("indented code at the start of the body stays code, and the lead after it is kept", async () => {
      const out = await identity(doc(`    ## code\n    example\n\nCurrent sailor.\n\n${LONG}\n\n## History\n\n${LONG}`), 100);
      expect(out).toBe(`## Identity\n    ## code\n    example\n\nCurrent sailor.\n\n${MARKER}`);
    });

    test("with no lead, sections are taken whole or not at all", async () => {
      const history = `## History\n\n${Array.from({ length: 20 }, (_, i) => `Year ${i}: a short old line.`).join("\n\n")}`;
      const out = await identity(doc(`${history}\n\n## Later\n\n${LONG}`), 100);
      expect(out).toBe(`## Identity\n${MARKER}`);
    });
  });
});

// #373: a hit is its best-matching chunk's section, not its opening.
describe("sections from chunks", () => {
  const para = (topic: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${topic} paragraph ${i + 1} fills out the section with plain field notes.`).join("\n\n");
  // Three sections, each well over the chunker's 100-token floor, so each is
  // its own chunk. The query word is only in the third.
  const FIELD_GUIDE =
    "---\ntype: study\ntitle: Sailor Field Guide\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n" +
    "Opening line of the field guide.\n\n" +
    `## Route markers\n\n${para("Marker", 8)}\n\n` +
    `## Water crossings\n\n${para("Crossing", 8)}\n\n` +
    `## Lichen survey\n\nThe lichen survey runs every spring on the north loop.\n\n${para("Survey", 8)}\n\n### Quadrats\n\n` +
    "The last line of the lichen section names the quadrat grid.\n";

  async function brainWith(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "brain-context-sections-"));
    temps.push(root);
    cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
    symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const ctx = await initContext({ root });
    const db = openDatabase(ctx.dbPath);
    await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
    return { ctx, db };
  }

  test("a query answered in a later section brings that section, not the document's opening", async () => {
    const { ctx, db } = await brainWith({ "studies/field-guide.md": FIELD_GUIDE });
    try {
      // The premise: the guide is three chunks, the lichen one last.
      const chunks = db
        .prepare("SELECT heading FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY chunk_index")
        .all("studies/field-guide.md") as { heading: string }[];
      expect(chunks.map((c) => c.heading)).toEqual(["Route markers", "Water crossings", "Lichen survey"]);
      const out = await assembleContext(db, ctx, { query: "lichen", maxTokens: 4000, includeIdentity: false, includeCurrentFocus: false });
      expect(out).toContain("#### Lichen survey");
      // A line of the section with no query word in it: only the whole section carries it.
      expect(out).toContain("Survey paragraph 8 fills out the section with plain field notes.");
      expect(out).not.toContain("Opening line of the field guide.");
      expect(out).not.toContain("Marker paragraph 1");
      // The section's own heading sits below the hit's, never at the output's levels.
      expect(out).toMatch(/^#{5,6} Quadrats$/m);
      expect(out).not.toMatch(/^#{1,4} Quadrats$/m);
    } finally {
      db.close();
    }
  });

  test("a section split over several chunks comes back whole, in order", async () => {
    const long = `## Lichen survey\n\n${para("Survey lichen", 120)}\n`;
    const { ctx, db } = await brainWith({
      "studies/lichen-atlas.md": `---\ntype: study\ntitle: Lichen Atlas\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n${long}`,
    });
    try {
      // The premise: the one section is more than one chunk, the later ones
      // named as its continuation.
      const headings = db
        .prepare("SELECT heading FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY chunk_index")
        .all("studies/lichen-atlas.md") as { heading: string }[];
      expect(headings.length).toBeGreaterThan(1);
      expect(headings.map((h) => h.heading.replace(/ \(cont\.\)$/, ""))).toEqual(headings.map(() => "Lichen survey"));
      const out = await assembleContext(db, ctx, { query: "lichen", maxTokens: 20000, includeIdentity: false, includeCurrentFocus: false });
      // Every paragraph, each once, in order.
      const at = Array.from({ length: 120 }, (_, i) => out.indexOf(`Survey lichen paragraph ${i + 1} fills`));
      expect(at.filter((i) => i === -1)).toEqual([]);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    } finally {
      db.close();
    }
  });

  test("a section split at its ### subsections gets their headings back", async () => {
    const long = `## Lichen survey\n\n### North loop\n\n${para("North lichen", 70)}\n\n### South loop\n\n${para("South lichen", 70)}\n`;
    const { ctx, db } = await brainWith({
      "studies/lichen-atlas.md": `---\ntype: study\ntitle: Lichen Atlas\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n${long}`,
    });
    try {
      // The premise: the chunker split the section at its subsections.
      const headings = (db
        .prepare("SELECT heading FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY chunk_index")
        .all("studies/lichen-atlas.md") as { heading: string }[]).map((h) => h.heading.replace(/ \(cont\.\)$/, ""));
      expect(headings).toContain("Lichen survey › North loop");
      expect(headings).toContain("Lichen survey › South loop");
      const out = await assembleContext(db, ctx, { query: "lichen", maxTokens: 20000, includeIdentity: false, includeCurrentFocus: false });
      const north = out.search(/^#{5,6} North loop$/m);
      const south = out.search(/^#{5,6} South loop$/m);
      expect(north).toBeGreaterThan(-1);
      expect(south).toBeGreaterThan(north);
      // Each subsection's every paragraph, in order, under its own heading.
      for (const [topic, from, to] of [["North", north, south], ["South", south, out.length]] as const) {
        const at = Array.from({ length: 70 }, (_, i) => out.indexOf(`${topic} lichen paragraph ${i + 1} fills`));
        expect({ topic, outside: at.filter((i) => i < from || i > to) }).toEqual({ topic, outside: [] });
        expect(at).toEqual([...at].sort((a, b) => a - b));
      }
    } finally {
      db.close();
    }
  });

  test("one hit's section never takes more than 40% of the budget", async () => {
    const huge = `## Lichen survey\n\n${para("Survey lichen", 200)}\n`;
    const { ctx, db } = await brainWith({
      "studies/lichen-atlas.md": `---\ntype: study\ntitle: Lichen Atlas\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n${huge}`,
    });
    try {
      const budget = 2000;
      const out = await assembleContext(db, ctx, { query: "lichen", maxTokens: budget, includeIdentity: false, includeCurrentFocus: false });
      const hit = out.split("\n\n### ").find((part) => part.includes("(studies/lichen-atlas.md)"))!;
      expect(hit).toBeDefined();
      expect(hit).toContain("(truncated — brain read studies/lichen-atlas.md)");
      expect(estimateTokens(`### ${hit.replace(/^### /, "")}`)).toBeLessThanOrEqual(budget * 0.4);
    } finally {
      db.close();
    }
  });
  const study = (title: string, body: string) =>
    `---\ntype: study\ntitle: ${title}\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n${body}`;
  /** The output's hits, each from its `### ` header to the next. */
  const hitsOf = (out: string) => out.split(/\n\n(?=### )/).filter((part) => part.startsWith("### ") && !part.startsWith("### Related"));

  test("a short subsection's heading stays with its own text, before a long one", async () => {
    // The chunker folds a short North into the chunk it names after South;
    // the section is read from the file, so each heading keeps its text.
    const body = `## Survey\n\n### North\n\nNorth content, one lichen line.\n\n### South\n\n${para("South lichen", 70)}\n`;
    const { ctx, db } = await brainWith({ "studies/survey.md": study("Survey", body) });
    try {
      const out = await assembleContext(db, ctx, { query: "lichen", maxTokens: 20000, includeIdentity: false, includeCurrentFocus: false });
      const order = [/^#{5,6} North$/m, /North content, one lichen line\./, /^#{5,6} South$/m, /South lichen paragraph 1 fills/].map((re) => out.search(re));
      expect(order.every((i) => i > -1)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    } finally {
      db.close();
    }
  });

  test("indented code that opens a section stays code, with its indentation", async () => {
    const body = `## Example\n\n    ## beacon literal\n    print(1)\n\n${para("Example beacon", 12)}\n`;
    const { ctx, db } = await brainWith({ "studies/example.md": study("Example", body) });
    try {
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 8000, includeIdentity: false, includeCurrentFocus: false });
      expect(out).toContain("#### Example\n    ## beacon literal\n    print(1)");
      expect(out).not.toMatch(/^#+ beacon literal$/m);
    } finally {
      db.close();
    }
  });

  test.each([
    ["an unclosed ~~~ fence", "~~~\nbeacon code with no closing fence"],
    ["an unclosed HTML comment", "<!-- beacon note never closed"],
  ])("a section ending in %s cannot swallow the hits after it", async (_, tail) => {
    const { ctx, db } = await brainWith({
      "studies/a-open.md": study("Open Ended", `## Log\n\nbeacon beacon beacon first.\n\n${tail}\n`),
      "studies/b-next.md": study("Next Hit", "## Notes\n\nA later beacon hit.\n"),
    });
    try {
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 8000, includeIdentity: false, includeCurrentFocus: false });
      // The premise: the open section comes first, the other hit after it.
      const open = out.indexOf("(studies/a-open.md)");
      const next = out.indexOf("(studies/b-next.md)");
      expect(open).toBeGreaterThan(-1);
      expect(next).toBeGreaterThan(open);
      // Parsed, the later hit's header is a heading of its own, not code or HTML.
      const headings = topLevelBlocks(out)
        .filter((b) => b.type === "heading")
        .map((b) => out.slice(b.start, b.end));
      expect(headings.some((h) => h.includes("(studies/b-next.md)"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a setext heading inside a section is demoted like an ATX one", async () => {
    const body = `## Log\n\nbeacon first line.\n\nbeacon title\n===\n\nUnder the setext heading.\n`;
    const { ctx, db } = await brainWith({ "studies/setext.md": study("Setext", body) });
    try {
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 8000, includeIdentity: false, includeCurrentFocus: false });
      const hit = hitsOf(out).find((h) => h.includes("(studies/setext.md)"))!;
      expect(hit).toContain("\n##### beacon title\n");
      // Parsed, no heading of the section is above the output's `####`.
      const depths = topLevelBlocks(hit).filter((b) => b.type === "heading").map((b) => b.depth);
      expect(depths.slice(2).every((d) => (d ?? 1) >= 5)).toBe(true);
    } finally {
      db.close();
    }
  });

  test.each([
    ["whose first block does not fit", `## Facts\n\nbeacon ${"abcdefgh ".repeat(200)}\n`],
    ["of which only a heading fits", `## Facts\n\n### Basics\n\nbeacon ${"abcdefgh ".repeat(200)}\n`],
  ])("a section %s falls back to the snippet", async (_, body) => {
    const { ctx, db } = await brainWith({ "studies/facts.md": study("Facts Sheet", body) });
    try {
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 300, includeIdentity: false, includeCurrentFocus: false });
      const hit = hitsOf(out).find((h) => h.includes("(studies/facts.md)"))!;
      expect(hit).toBeDefined();
      expect(hit).not.toContain("#### Facts");
      expect(hit).not.toContain("(truncated");
      expect(hit.split("\n")[1]).toContain("beacon");
    } finally {
      db.close();
    }
  });

  test("a hit's snippet is held to the 40% a hit may take, too", async () => {
    const body = `## Facts\n\nbeacon ordinary sentence about the harbour and its lights, long enough to matter here.\n`;
    const { ctx, db } = await brainWith({ "studies/facts.md": study("Facts Sheet", body) });
    try {
      const budget = 60;
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: budget, includeIdentity: false, includeCurrentFocus: false });
      for (const hit of hitsOf(out)) expect({ hit, tokens: estimateTokens(hit) <= budget * 0.4 }).toEqual({ hit, tokens: true });
      // The control: with room, the hit is in.
      const roomy = await assembleContext(db, ctx, { query: "beacon", maxTokens: 400, includeIdentity: false, includeCurrentFocus: false });
      expect(roomy).toContain("(studies/facts.md)");
    } finally {
      db.close();
    }
  });

  test.each([
    ["service", "The harbour services run at dawn."],
    ["hike", "Hiking the north loop takes a day."],
    ["cafe", "The café by the ferry opens early."],
  ])("chunk matching reads %s as the full-text lane does", async (query, line) => {
    const { ctx, db } = await brainWith({ "studies/words.md": study("Words", `## Notes\n\n${line}\n`) });
    try {
      const { results } = await hybridSearch(db, { query, mode: "fts", chunks: true }, { taxonomy: ctx.taxonomy });
      const hit = results.find((r) => r.path === "studies/words.md");
      expect(hit).toBeDefined();
      expect(hit!.chunks!.map((c) => c.content)).toEqual([expect.stringContaining(line)]);
    } finally {
      db.close();
    }
  });
  test.each([
    ["after", (weather: string) => `${weather}## Signal\n\nThe beacon code is violet.\n`],
    ["before", (weather: string) => `## Signal\n\nThe beacon code is violet.\n\n${weather}`],
  ])("a short section folded into a long one %s it still answers from its own text", async (_, layout) => {
    const weather = `## Weather\n\n${para("Weather", 8)}\n\n`;
    const { ctx, db } = await brainWith({ "studies/folded.md": study("Folded", layout(weather)) });
    try {
      // The premise: the chunker folded Signal into Weather's chunk.
      const chunks = db
        .prepare("SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ?")
        .all("studies/folded.md") as { content: string }[];
      expect(chunks.filter((c) => c.content.includes("violet") && c.content.includes("Weather paragraph 1"))).toHaveLength(1);
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 4000, includeIdentity: false, includeCurrentFocus: false });
      const hit = hitsOf(out).find((h) => h.includes("(studies/folded.md)"))!;
      expect(hit).toContain("#### Signal\nThe beacon code is violet.");
      expect(hit).not.toContain("Weather paragraph 1");
    } finally {
      db.close();
    }
  });

  test("when the match cannot be placed in a folded chunk, the hit keeps its snippet", async () => {
    const body = `## Weather\n\n${para("Weather", 8)}\n\n## Signal\n\nThe beacon code is violet.\n`;
    const { ctx, db } = await brainWith({ "studies/folded.md": study("Folded", body) });
    // Only the match line fails; the chunk itself is still matched.
    const real = db.prepare.bind(db);
    const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("highlight(chunks_fts")) throw new Error("injected highlight failure");
      return real(sql);
    }) as typeof db.prepare);
    try {
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 4000, includeIdentity: false, includeCurrentFocus: false });
      const hit = hitsOf(out).find((h) => h.includes("(studies/folded.md)"))!;
      expect(hit).toBeDefined();
      // Not Weather, which holds most of the chunk's lines: the snippet, which holds the match.
      expect(hit).not.toContain("Weather paragraph 1");
      expect(hit).not.toContain("####");
      expect(hit).toContain("violet");
    } finally {
      spy.mockRestore();
      db.close();
    }
  });

  test("when chunk matching fails, the context still assembles, from snippets", async () => {
    const { ctx, db } = await brainWith({ "studies/survey.md": study("Survey", `## Log\n\nThe beacon survey log.\n`) });
    const real = db.prepare.bind(db);
    const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("-bm25(chunks_fts, 2.0, 1.0) AS score") || sql.includes("highlight(chunks_fts")) {
        throw new Error("injected chunk failure");
      }
      return real(sql);
    }) as typeof db.prepare);
    try {
      const warnings: string[] = [];
      const out = await assembleContext(db, ctx, { query: "beacon", maxTokens: 4000, includeIdentity: false, includeCurrentFocus: false, warnings });
      expect(out).toContain("(studies/survey.md)");
      expect(out).not.toContain("#### Log");
      expect(warnings).toContain("chunk matching failed: injected chunk failure");
    } finally {
      spy.mockRestore();
      db.close();
    }
  });
});
