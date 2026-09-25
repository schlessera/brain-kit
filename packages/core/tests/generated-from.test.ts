/**
 * `generated_from` end to end (#430): validate refuses a non-string, the
 * indexer stores it, search results carry it so the reranker can weigh it,
 * and a schema 9 database gains the column on open.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openDatabase, SCHEMA_VERSION } from "../src/lib/db";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const doc = (title: string, extra = "") =>
  `---\ntype: note\ntitle: ${title}\ncreated: 2026-01-01\nupdated: 2026-06-01\ntags: [t]\nstatus: active\nrelevance: secondary\n${extra}---\n\nThe lantern wick.\n`;

describe("over a temp brain", () => {
  let root: string;

  beforeAll(async () => {
    root = makeTempBrain({ empty: true });
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    mkdirSync(join(root, "notes"), { recursive: true });
    // Same body, title length and date: only generated_from differs.
    writeFileSync(join(root, "notes/written.md"), doc("Lantern A"));
    writeFileSync(join(root, "notes/generated.md"), doc("Lantern B", "generated_from: notes/written.md\n"));
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  });

  afterAll(() => cleanup(root));

  test("the indexer stores generated_from", () => {
    const db = openDatabase(join(root, "brain.db"), { readonly: true });
    try {
      const rows = db.prepare("SELECT path, generated_from FROM documents ORDER BY path").all();
      expect(rows).toEqual([
        { path: "notes/generated.md", generated_from: "notes/written.md" },
        { path: "notes/written.md", generated_from: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("search results carry it, and the reranker puts the generated document second", async () => {
    const search = async (rerank: string) => {
      const { stdout, code } = await runCli(root, ["search", "lantern", "--mode", "fts", "--rerank", rerank, "--json"]);
      expect(code).toBe(0);
      return JSON.parse(stdout).results as { path: string; generatedFrom: string | null }[];
    };
    // The premise: without reranking, the generated document comes first.
    expect((await search("none")).map((r) => r.path)).toEqual(["notes/generated.md", "notes/written.md"]);
    const ranked = await search("heuristic");
    expect(ranked.map((r) => [r.path, r.generatedFrom])).toEqual([
      ["notes/written.md", null],
      ["notes/generated.md", "notes/written.md"],
    ]);
  });

  test("validate reports a generated_from that is not a non-empty string", async () => {
    writeFileSync(join(root, "notes/bad.md"), doc("Bad", "generated_from: []\n"));
    try {
      const { stdout } = await runCli(root, ["validate", "--json"]);
      const issues = (JSON.parse(stdout).issues as { file: string; level: string; message: string }[])
        .filter((i) => i.file === "notes/bad.md" && i.message.includes("generated_from"));
      expect(issues).toEqual([{
        file: "notes/bad.md",
        level: "error",
        message: "Invalid generated_from: []. It must be a non-empty string: a repo-relative path or a tool name",
      }]);
    } finally {
      rmSync(join(root, "notes/bad.md"));
    }
  });
});

test("opening a schema 9 database adds the column and makes the next index re-read its files", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-generated-from-"));
  try {
    const path = join(dir, "brain.db");
    // A schema 10 database taken back to what schema 9 looked like.
    const db = openDatabase(path);
    db.run("ALTER TABLE documents DROP COLUMN generated_from");
    db.run("INSERT INTO documents(path,title,type,status,created,updated,content,content_hash,asset_type,indexed_at) VALUES ('notes/a.md','A','note','active','2026-01-01','2026-01-01','x','hash-a','markdown','2026-01-01')");
    db.run("INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('schema_version', '9')");
    db.close();

    const reopened = openDatabase(path);
    try {
      const columns = (reopened.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain("generated_from");
      expect(reopened.prepare("SELECT content_hash FROM documents WHERE path = 'notes/a.md'").get()).toEqual({ content_hash: null });
      expect(reopened.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
