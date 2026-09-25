/**
 * `assembleContext` (#370): fills its budget greedily, keeps identity and
 * current focus whole or cuts them at a paragraph boundary, never repeats
 * them as search hits, and emits no FTS5 highlight markers or stray
 * headings. Corpus tests index a temp copy of fixtures/corpus in-process;
 * the unit tests build a small in-memory index by hand.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
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

  test("an identity that does not fit is cut at a paragraph boundary, with a pointer to the file", async () => {
    const identity = matter(readFileSync(join(ctx.root, "me/identity.md"), "utf8")).content.trim();
    const out = await assembleContext(db, ctx, { query: "astronomy", maxTokens: 200, includeCurrentFocus: false });
    const section = out.split("\n\n(truncated — brain read me/identity.md)")[0]!;
    expect(out).toContain("(truncated — brain read me/identity.md)");
    const kept = section.replace(/^## Identity\n/, "");
    // Whole paragraphs only: what is kept is a prefix of the file ending
    // where a paragraph ends.
    expect(kept.length).toBeGreaterThan(0);
    expect(identity.startsWith(kept)).toBe(true);
    expect(identity.slice(kept.length).startsWith("\n\n")).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
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
});
