/**
 * `assembleContext` (#370): fills its budget greedily, keeps identity and
 * current focus whole or cuts them at a paragraph boundary, never repeats
 * them as search hits, and emits no FTS5 highlight markers or stray
 * headings. Corpus tests index a temp copy of fixtures/corpus in-process;
 * the unit tests build a small in-memory index by hand.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import matter from "gray-matter";
import { fromMarkdown } from "mdast-util-from-markdown";

import { initContext, type BrainContext } from "../src/lib/context";
import { assembleContext, estimateTokens } from "../src/lib/context-assembler";
import { openDatabase } from "../src/lib/db";
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
    const identity = matter(readFileSync(join(ctx.root, "me/identity.md"), "utf8")).content;
    // The premise: the heading sits past the 500 characters main kept.
    expect(identity.indexOf("## How to Work With Alex")).toBeGreaterThan(500);
    expect(await assemble("astronomy", 4000)).toContain("## How to Work With Alex");
  });

  // "astronomy" matches too little of the corpus to outgrow 2000 tokens, so a
  // broader query shows the budget being used.
  const BROAD = "bookshelf telescope knee trail sleep owl walnut messier";

  test("a larger budget yields strictly more, and neither exceeds its budget", async () => {
    const small = await assemble(BROAD, 2000);
    const large = await assemble(BROAD, 8000);
    expect(large.length).toBeGreaterThan(small.length);
    expect(estimateTokens(small)).toBeLessThanOrEqual(2000);
    expect(estimateTokens(large)).toBeLessThanOrEqual(8000);
    expect(estimateTokens(await assemble("astronomy", 4000))).toBeLessThanOrEqual(4000);
  });

  test("a budget with more material than room is mostly used", async () => {
    // Floor, not target: greedy fill leaves only what no remaining hit fits.
    expect(estimateTokens(await assemble(BROAD, 2000))).toBeGreaterThan(1600);
  });

  test("includes current focus whole when it fits", async () => {
    const focus = matter(readFileSync(join(ctx.root, "context/current-focus.md"), "utf8")).content.trim();
    // The premise: more than the 800 characters main kept.
    expect(focus.length).toBeGreaterThan(800);
    expect(await assemble("astronomy", 4000)).toContain(`## Current Focus\n${focus}`);
  });

  test("carries no FTS5 highlight markers", async () => {
    const out = await assemble("astronomy", 4000);
    // The premise: the query hits the full-text lane, whose snippets carry them.
    expect(out).toContain("### ");
    expect(out).not.toContain(">>>");
    expect(out).not.toContain("<<<");
  });

  test("identity and current focus each appear once, not again as a search hit", async () => {
    const out = await assemble("astronomy", 4000);
    expect(out.split("\n").filter((l) => l === "## Identity")).toHaveLength(1);
    expect(out.split("\n").filter((l) => l === "## Current Focus")).toHaveLength(1);
    expect(out).not.toContain("(me/identity.md)");
    expect(out).not.toContain("(context/current-focus.md)");
  });

  test("an identity that does not fit leads with its summary, with a pointer to the file", async () => {
    // The corpus identity has no text before its first "##" heading, and its
    // first section does not fit in 200 tokens: what leads is the summary.
    const out = await assembleContext(db, ctx, { query: "astronomy", maxTokens: 200, includeCurrentFocus: false });
    expect(out.startsWith(
      "## Identity\nWho Alex Example is — a park ranger tracking health, woodworking, and astronomy\n\n(truncated — brain read me/identity.md)"
    )).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
  });
});

describe("neighbours over fixtures/corpus", () => {
  let ctx: BrainContext;
  let db: Database;
  // "dadoes shiplap" matches only the bookshelf plan, so its directory index
  // and its links reach the output only as neighbours.
  const QUERY = "dadoes shiplap";
  const PLAN = "projects/active/bookshelf/plan.md";
  const INDEX_LINE = "- Bookshelf Build — Index (projects/active/bookshelf/_index.md) — Registry for the walnut-and-cedar bookshelf build — plan, status, and overview";

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

  test("when the search hit uses up the budget, no neighbour is added", async () => {
    const full = await assemble(4000);
    const hitSection = full.split("\n\n### Related")[0]!;
    // Room for the hit and less than the floor besides.
    const out = await assemble(estimateTokens(hitSection) + 5);
    expect(out).toBe(hitSection);
    expect(out).not.toContain("### Related");
  });

  test("a budget with room for one related line gets exactly that line", async () => {
    const full = await assemble(4000);
    const hitSection = full.split("\n\n### Related")[0]!;
    const oneLine = `${hitSection}\n\n### Related\n${INDEX_LINE}`;
    expect(await assemble(estimateTokens(oneLine))).toBe(oneLine);
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
    // Two hits whose sections are exactly 400 characters (100 tokens) each.
    // At a budget of 200, both fit only if the "\n\n" between them is free.
    const section = (title: string, path: string) => `### ${title} (${path}) · updated 2026-01-01 · active\nnadir alpha`;
    const pad = (path: string) => "T".repeat(400 - section("", path).length);
    addDoc("notes/edge-1.md", pad("notes/edge-1.md"), "nadir alpha");
    addDoc("notes/edge-2.md", pad("notes/edge-2.md"), "nadir alpha");
    expect(section(pad("notes/edge-1.md"), "notes/edge-1.md")).toHaveLength(400);

    const out = await assembleContext(db, ctx, { query: "nadir", maxTokens: 200, includeIdentity: false, includeCurrentFocus: false });
    expect(out).toContain("(notes/edge-");
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
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
      Array.from({ length: 5 }, () => ["paragraph"])
    );
  });

  describe("identity leads with its lead, then whole sections", () => {
    // A 300-character lead, then a 2,000-character section made of short
    // paragraphs (each would fit on its own), then a second section.
    const LEAD = `${"Ranger at the north preserve; speaks two languages; reach me by radio. ".repeat(4).trim()}`;
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
});
