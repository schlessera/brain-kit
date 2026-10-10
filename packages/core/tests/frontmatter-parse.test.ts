/**
 * parseFrontmatter (@schlessera/brain-common, #142) keeps every parse
 * independent of gray-matter's global content cache. The package's own test
 * proves that against the cache itself; these run byte-identical twins through
 * core's real indexer and archiver in one process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { archiveDocument } from "../src/lib/archiver";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { parseMarkdownFiles } from "../src/lib/indexer/parse";
import type { IndexRun } from "../src/lib/indexer/types";
import { cleanup, makeTempBrain } from "./cli-harness";


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
