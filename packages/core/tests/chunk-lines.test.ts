/**
 * #3683: the index records each chunk's source lines (`chunks.start_line`,
 * `chunks.end_line`, schema 16), which context assembly reads to widen a
 * folded chunk. An index from before them reads NULL until the next run,
 * which re-chunks every document for the chunker version that records them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { CHUNKER_VERSION } from "../src/lib/chunker";
import { initContext } from "../src/lib/context";
import { openDatabase, SCHEMA_VERSION } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";

const CORE_ROOT = resolve(import.meta.dir, "..");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const para = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} paragraph ${i + 1} fills out the section with plain field notes.`).join("\n\n");
const study = (body: string) => `---\ntype: study\ntitle: Folded\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [sailor]\n---\n\n${body}`;
const PATH = "studies/folded.md";
/** The 1-based line of the text after `file`'s frontmatter that starts with `start`, as the chunker counts it. */
const lineOf = (file: string, start: string) => file.slice(file.indexOf("\n---\n") + 5).split("\n").findIndex((line) => line.startsWith(start)) + 1;

async function brainWith(file: string) {
  const root = mkdtempSync(join(tmpdir(), "brain-chunk-lines-"));
  temps.push(root);
  cpSync(join(CORE_ROOT, "fixtures/corpus"), root, { recursive: true });
  symlinkSync(resolve(CORE_ROOT, "../../node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "studies"), { recursive: true });
  writeFileSync(join(root, PATH), file);
  const ctx = await initContext({ root });
  return { root, ctx };
}

const rows = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare("SELECT c.heading, c.start_line, c.end_line FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY c.chunk_index")
    .all(PATH) as { heading: string; start_line: number | null; end_line: number | null }[];

describe("recorded chunk lines in the index", () => {
  test("a schema 15 index gains the columns, and the next run fills them", async () => {
    const file = study(`## Signal\n\nThe beacon code is violet.\n\n## Tides\n\n${para("Tide", 8)}\n`);
    const { root, ctx } = await brainWith(file);
    const db = openDatabase(ctx.dbPath);
    await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
    // Back to schema 15 and the chunker before it: no columns, no lines.
    db.run("ALTER TABLE chunks DROP COLUMN start_line");
    db.run("ALTER TABLE chunks DROP COLUMN end_line");
    db.run("UPDATE documents SET chunker_version = 3");
    db.run("INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('schema_version', '15')");
    db.close();

    const reopened = openDatabase(ctx.dbPath);
    try {
      expect(SCHEMA_VERSION).toBe(16);
      expect(reopened.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get()).toEqual({ value: "16" });
      expect(rows(reopened)).toEqual([{ heading: "Tides", start_line: null, end_line: null }]);
      await indexAll(reopened, { root, taxonomy: ctx.taxonomy, quiet: true });
      // The chunk is the folded Signal and Tides: Signal's heading to Tides' last line.
      expect(rows(reopened)).toEqual([{ heading: "Tides", start_line: lineOf(file, "## Signal"), end_line: lineOf(file, "Tide paragraph 8 ") }]);
      expect(reopened.prepare("SELECT chunker_version FROM documents WHERE path = ?").get(PATH)).toEqual({ chunker_version: CHUNKER_VERSION });
    } finally {
      reopened.close();
    }
  });

  test("a chunk kept across an edit moves its lines with it", async () => {
    const body = `## Notes\n\n${para("Note", 8)}\n\n## Tides\n\n${para("Tide", 8)}\n`;
    const { root, ctx } = await brainWith(study(body));
    const db = openDatabase(ctx.dbPath);
    try {
      await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
      const before = rows(db);
      expect(before.map((r) => r.heading)).toEqual(["Notes", "Tides"]);
      // A new section first: Tides' chunk keeps its text, so its row is kept, on new lines.
      const edited = study(`## Weather\n\n${para("Weather", 8)}\n\n${body}`);
      writeFileSync(join(root, PATH), edited);
      await indexAll(db, { root, taxonomy: ctx.taxonomy, quiet: true });
      const after = rows(db);
      expect(after.map((r) => r.heading)).toEqual(["Weather", "Notes", "Tides"]);
      expect(before[1]).toEqual({ heading: "Tides", start_line: lineOf(study(body), "## Tides"), end_line: lineOf(study(body), "Tide paragraph 8 ") });
      expect(after[2]).toEqual({ heading: "Tides", start_line: lineOf(edited, "## Tides"), end_line: lineOf(edited, "Tide paragraph 8 ") });
      expect(after[2]!.start_line).toBeGreaterThan(before[1]!.start_line!);
    } finally {
      db.close();
    }
  });
});
