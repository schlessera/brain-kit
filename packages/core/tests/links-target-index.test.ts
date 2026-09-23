/**
 * links.target_id is indexed (#134).
 *
 * The links primary key is (source_id, target), so "what does this document
 * point at" was always a lookup and "what points at this document" was a scan
 * of the whole table, once per visited node per hop of a brain_links
 * `direction: "incoming"` walk. These tests pin the plan SQLite picks for that
 * query, and that a brain indexed before the index existed gains it on its next
 * writable open without a reindex.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openDatabase, SCHEMA_VERSION } from "../src/lib/db.js";
import { cleanup, makeTempBrain, runCli } from "./cli-harness.js";

/** The `incoming` branch of brain_links in src/mcp-server.ts, verbatim. */
const INCOMING_QUERY = `SELECT d2.path AS source, d.path AS target
                   FROM links l
                   JOIN documents d ON d.id = l.target_id
                   JOIN documents d2 ON d2.id = l.source_id
                   WHERE d.path = ?`;

/** The last schema without the index. Fixed, not SCHEMA_VERSION - 1: a later bump must not move it. */
const PRE_INDEX_VERSION = 8;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-links-index-"));
  dirs.push(dir);
  return join(dir, "brain.db");
}

function seed(db: Database, docs: number): void {
  const insertDoc = db.prepare(
    "INSERT INTO documents (path, title, type, created, updated, content, indexed_at) VALUES (?, ?, 'note', '2026-01-01', '2026-01-01', 'x', '2026-01-01')"
  );
  const insertLink = db.prepare("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < docs; i++) insertDoc.run(`n${i}.md`, `N${i}`);
    for (let i = 1; i <= docs; i++) {
      for (let k = 1; k <= 5; k++) {
        const target = ((i + k * 7) % docs) + 1;
        insertLink.run(i, `n${target - 1}`, target);
      }
    }
  })();
}

function plan(db: Database): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${INCOMING_QUERY}`).all("n0.md") as { detail: string }[]
  ).map((row) => row.detail);
}

function linkIndexes(db: Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links' AND sql IS NOT NULL")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** Turn a current database into one as the previous schema left it. */
function downgradeToPreIndex(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.run("DROP INDEX IF EXISTS idx_links_target_id");
  raw.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(PRE_INDEX_VERSION)]);
  raw.close();
}

describe("links.target_id index", () => {
  test("the query under test is still the one brain_links runs", () => {
    // A stale copy would keep the plan test green while the real query moved.
    const source = readFileSync(join(import.meta.dir, "../src/mcp-server.ts"), "utf8");
    expect(source.includes(INCOMING_QUERY)).toBe(true);
  });

  test("the brain_links incoming query searches links by target_id instead of scanning it", () => {
    const db = openDatabase(tempDbPath());
    try {
      seed(db, 200);
      const detail = plan(db);
      expect(detail.some((d) => /^SCAN l\b/.test(d)), detail.join("\n")).toBe(false);
      expect(
        detail.some((d) => /^SEARCH l USING (COVERING )?INDEX \S+ \(target_id=\?\)/.test(d)),
        detail.join("\n")
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  test(`a v${PRE_INDEX_VERSION} database gains the index on its next writable open, with its rows intact`, () => {
    const dbPath = tempDbPath();
    const first = openDatabase(dbPath);
    seed(first, 50);
    first.close();
    downgradeToPreIndex(dbPath);

    const before = new Database(dbPath, { readonly: true });
    expect(linkIndexes(before)).not.toContain("idx_links_target_id");
    const docsBefore = (before.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const linksBefore = before.prepare("SELECT source_id, target, target_id FROM links ORDER BY source_id, target").all();
    before.close();

    openDatabase(dbPath).close();

    const after = new Database(dbPath, { readonly: true });
    try {
      expect(linkIndexes(after)).toContain("idx_links_target_id");
      const version = after
        .prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(Number.parseInt(version.value, 10)).toBe(SCHEMA_VERSION);
      expect((after.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(docsBefore);
      expect(after.prepare("SELECT source_id, target, target_id FROM links ORDER BY source_id, target").all()).toEqual(
        linksBefore
      );
      expect(plan(after).some((d) => /^SCAN l\b/.test(d))).toBe(false);
    } finally {
      after.close();
    }
  });

  test("brain doctor stops asking for a reindex once the upgraded database has been opened writable", async () => {
    const root = makeTempBrain();
    dirs.push(root);
    // Satisfy the MCP check via project config so doctor never falls through to
    // probing a host `claude` CLI (up to 15s per run, and machine-dependent).
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
    );
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    const dbPath = join(root, "brain.db");
    downgradeToPreIndex(dbPath);

    const dbCheck = async () => {
      const result = await runCli(root, ["doctor", "--json"]);
      const checks = JSON.parse(result.stdout).checks as { id: string; status: string; detail: string }[];
      return checks.find((c) => c.id === "db")!;
    };

    // Precondition: doctor does notice an old schema, so the assertion below
    // is not passing because the check is blind.
    const stale = await dbCheck();
    expect(stale.detail).toContain(`schema_version ${PRE_INDEX_VERSION} <`);

    openDatabase(dbPath).close();

    const upgraded = await dbCheck();
    expect(upgraded.detail).not.toContain("schema_version");
    expect(upgraded.status).toBe("pass");
  });
});
