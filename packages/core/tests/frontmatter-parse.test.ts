/**
 * parseFrontmatter keeps every parse independent of gray-matter's global
 * content cache (#142).
 *
 * gray-matter, called without options, answers byte-identical input from
 * `matter.cache` with a shallow copy of one shared file object. This file is
 * the one test allowed to import gray-matter directly (see
 * scripts/check-frontmatter-parse.ts): it seeds and reads that cache to prove
 * the helper neither consults nor grows it. The reader and writer tests at the
 * bottom go through the real indexer and archiver in this one process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

import { archiveDocument } from "../src/lib/archiver";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { parseFrontmatter } from "../src/lib/frontmatter-parse";
import { indexAll } from "../src/lib/indexer";
import { parseMarkdownFiles } from "../src/lib/indexer/parse";
import type { IndexRun } from "../src/lib/indexer/types";
import { cleanup, makeTempBrain } from "./cli-harness";

/** gray-matter's global cache, which its types do not declare. */
const cache = () => (matter as unknown as { cache: Record<string, unknown> }).cache;

// Every test writes its own bytes: a document another test (or file) already
// parsed would otherwise decide the outcome through the very cache under test.
let serial = 0;
const unique = (label: string) => `${label}-${process.pid}-${++serial}-${Math.random().toString(36).slice(2)}`;

function twinDocument(label: string): string {
  return [
    "---",
    `title: ${unique(label)}`,
    "type: note",
    "status: active",
    "created: 2026-03-06",
    "tags: [alpha, beta]",
    "meta:",
    "  owner: Odysseus",
    "  review: { every: 30 }",
    "---",
    "Body text.",
    "",
  ].join("\n");
}

describe("independent parses", () => {
  test("two byte-identical documents share no data, top-level or nested", () => {
    const raw = twinDocument("independent");
    const first = parseFrontmatter(raw);
    const second = parseFrontmatter(raw);

    // The fields under test are really there, so the comparisons below are not vacuous.
    expect(first.data.tags).toEqual(["alpha", "beta"]);
    expect(first.data.meta.review).toEqual({ every: 30 });

    first.data.status = "archived";
    first.data.tags.push("gamma");
    first.data.meta.review.every = 1;
    first.content = "changed";

    expect(second.data.status).toBe("active");
    expect(second.data.tags).toEqual(["alpha", "beta"]);
    expect(second.data.meta.review).toEqual({ every: 30 });
    expect(second.content).toBe("Body text.\n");
    expect(parseFrontmatter(raw).data).toMatchObject({ status: "active", tags: ["alpha", "beta"] });
  });

  test("invalid YAML throws on every parse, not only the first", () => {
    const raw = `---\ntitle: "${unique("unclosed")}\nstatus: archived\n---\nBody\n`;
    expect(() => parseFrontmatter(raw)).toThrow();
    expect(() => parseFrontmatter(raw)).toThrow();
  });
});

describe("the global cache", () => {
  test("parsing many distinct inputs adds nothing to it", () => {
    const before = Object.keys(cache()).length;
    for (let i = 0; i < 200; i++) parseFrontmatter(twinDocument(`distinct-${i}`));
    expect(Object.keys(cache()).length).toBe(before);
  });

  test("an entry already in it cannot contaminate a helper parse", () => {
    const raw = twinDocument("seeded");
    // A bare call, as every caller made before #142, seeds the cache; mutating
    // what it returned mutates the cached entry itself.
    const seeded = matter(raw);
    seeded.data.status = "archived";
    seeded.data.tags.push("leaked");
    expect(Object.keys(cache())).toContain(raw);
    // The contamination is real: a second bare call sees it.
    expect(matter(raw).data.status).toBe("archived");

    const parsed = parseFrontmatter(raw);
    expect(parsed.data.status).toBe("active");
    expect(parsed.data.tags).toEqual(["alpha", "beta"]);
  });

  test("a failed parse cached by a bare call does not turn into a success", () => {
    const raw = `---\ntitle: "${unique("cached-failure")}\n---\nBody\n`;
    expect(() => matter(raw)).toThrow();
    expect(matter(raw).data).toEqual({}); // gray-matter's own false success
    expect(() => parseFrontmatter(raw)).toThrow();
  });
});

describe("parsing behaviour is unchanged", () => {
  test("unquoted dates are Date objects, quoted ones strings", () => {
    const { data } = parseFrontmatter(`---\ncreated: 2026-03-06\nupdated: "2026-03-07"\nid: ${unique("d")}\n---\n`);
    expect(data.created).toBeInstanceOf(Date);
    expect((data.created as Date).toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(data.updated).toBe("2026-03-07");
  });

  test("a leading byte order mark is stripped from the content", () => {
    const parsed = parseFrontmatter(`\u{FEFF}---\ntitle: ${unique("bom")}\n---\nBody\n`);
    expect(parsed.data.title).toStartWith("bom-");
    expect(parsed.content).toBe("Body\n");
  });

  test("CRLF delimiters parse, and the body keeps its line endings", () => {
    const parsed = parseFrontmatter(`---\r\ntitle: ${unique("crlf")}\r\n---\r\nBody\r\n`);
    expect(parsed.data.title).toStartWith("crlf-");
    expect(parsed.content).toBe("Body\r\n");
  });

  test("empty, missing and unclosed frontmatter read as before", () => {
    expect(parseFrontmatter("")).toMatchObject({ data: {}, content: "" });
    const empty = parseFrontmatter(`---\n---\n${unique("empty")}\n`);
    expect(empty.data).toEqual({});
    expect((empty as unknown as { isEmpty: boolean }).isEmpty).toBe(true);
    const none = `# ${unique("none")}\n`;
    expect(parseFrontmatter(none)).toMatchObject({ data: {}, content: none });
    // No closing fence: the rest of the file is the block, and there is no body.
    expect(parseFrontmatter(`---\ntitle: ${unique("open")}\n`).content).toBe("");
    expect(parseFrontmatter(`---\ntitle: ${unique("open")}\n`).data.title).toStartWith("open-");
  });

  test("the caller's options are kept, and not mutated", () => {
    const options = { delimiters: "~~~" as const, excerpt: true, excerpt_separator: "<!-- more -->" };
    const snapshot = JSON.stringify(options);
    const parsed = parseFrontmatter(`~~~\ntitle: ${unique("delims")}\n~~~\nLead\n<!-- more -->\nRest\n`, options);
    expect(parsed.data.title).toStartWith("delims-");
    expect(parsed.excerpt).toBe("Lead\n");
    expect(JSON.stringify(options)).toBe(snapshot);
    // Default delimiters do not apply under a custom one.
    expect(parseFrontmatter(`---\ntitle: x\n---\n`, { delimiters: "~~~" }).data).toEqual({});
  });

  test("a custom engine is used", () => {
    const parsed = parseFrontmatter(`---json\n{"title": "${unique("json")}"}\n---\n`);
    expect(parsed.data.title).toStartWith("json-");
    const custom = parseFrontmatter(`---\nanything ${unique("engine")}\n---\n`, {
      engines: { yaml: (input: string) => ({ seen: input.trim().split(" ")[0] }) },
    });
    expect(custom.data).toEqual({ seen: "anything" });
  });
});

describe("through the real readers and writers, in one process", () => {
  let root: string;
  let db: Database;

  beforeEach(() => {
    root = makeTempBrain();
  });
  afterEach(() => {
    db?.close();
    cleanup(root);
  });

  function readerRun(warnings: string[]): IndexRun {
    return {
      root,
      force: true,
      stats: { unchanged: 0 },
      warn: (message: string) => warnings.push(message),
      report: () => {},
    } as unknown as IndexRun;
  }

  test("updating one parsed twin in place cannot change what the indexer reads for the other", () => {
    const raw = twinDocument("reader");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/twin-a.md"), raw);
    writeFileSync(join(root, "notes/twin-b.md"), raw);

    const first = parseMarkdownFiles(readerRun([]), ["notes/twin-a.md"], new Map()).files[0];
    expect(first.data.tags).toEqual(["alpha", "beta"]);
    // What a writer does to the data it parsed before serializing it back.
    first.data.status = "archived";
    first.data.tags.push("gamma");
    first.data.meta.review.every = 1;

    const [a, b] = parseMarkdownFiles(readerRun([]), ["notes/twin-a.md", "notes/twin-b.md"], new Map()).files;
    for (const doc of [a, b]) {
      expect({ path: doc.path, status: doc.data.status, tags: doc.data.tags, review: doc.data.meta.review }).toEqual({
        path: doc.path,
        status: "active",
        tags: ["alpha", "beta"],
        review: { every: 30 },
      });
    }
  });

  test("the indexer reports broken frontmatter as invalid on every pass", () => {
    const raw = `---\ntitle: "${unique("broken")}\ntype: note\n---\nBody\n`;
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/broken.md"), raw);
    for (const pass of [1, 2]) {
      const warnings: string[] = [];
      const result = parseMarkdownFiles(readerRun(warnings), ["notes/broken.md"], new Map());
      expect({ pass, files: result.files.length, warnings }).toEqual({
        pass,
        files: 0,
        warnings: ["  SKIP: notes/broken.md — invalid frontmatter"],
      });
    }
  });

  test("archiving one twin leaves the other active in the index", async () => {
    const raw = twinDocument("writer");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/twin-a.md"), raw);
    writeFileSync(join(root, "notes/twin-b.md"), raw);
    const ctx = await initContext({ root });
    db = openDatabase(ctx.dbPath);
    const reindex = () => indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true, graph: false });
    await reindex();

    await archiveDocument(root, "notes/twin-a.md", { db, reindex });

    const status = (path: string) =>
      (db.query("SELECT status FROM documents WHERE path = ?").get(path) as { status: string } | null)?.status;
    expect(status("notes/twin-a.md")).toBe("archived");
    expect(status("notes/twin-b.md")).toBe("active");
    expect(readFileSync(join(root, "notes/twin-b.md"), "utf8")).toBe(raw);
  });
});
