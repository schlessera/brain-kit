/**
 * The SQLite prepare gate (scripts/check-sqlite-prepare.ts, #4808): ui-server
 * source takes fixed-text statements from `db.query`, which compiles once per
 * connection, and keeps `db.prepare` only at the sites the gate allows by name.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { ALLOWED, check, scanTree } from "../scripts/check-sqlite-prepare";

const ROOT = resolve(import.meta.dir, "..");
const FILE = "packages/ui-server/src/drafts/example.ts";
const run = (text: string, file = FILE, allow = ALLOWED) => check(new Map([[file, text]]), allow);

describe("the refused shapes", () => {
  test("a function-scope db.prepare of an UPDATE is refused with its file and line", () => {
    const text = [
      'import type { Database } from "bun:sqlite";',
      "export function touch(db: Database, id: string, at: number) {",
      '  db.prepare("UPDATE session_drafts SET updated_at = ? WHERE draft_id = ?").run(at, id);',
      "}",
      "",
    ].join("\n");
    const { findings } = run(text);
    expect(findings.map((f) => ({ file: f.file, line: f.line }))).toEqual([{ file: FILE, line: 3 }]);
    expect(findings[0]!.message).toContain("db.query()");
  });

  test("templates, conditionals, concatenations and names that say sql count as SQL text", () => {
    for (const call of [
      "db.prepare(`SELECT ${COLUMNS} FROM principals WHERE id = ?`)",
      'db.prepare(journal ? JOURNAL_SQL : "SELECT 1")',
      'db.prepare("SELECT * FROM t WHERE " + clause)',
      "db.prepare(UPSERT_SESSION_SQL)",
      'db.prepare(sql.replace("(?)", marks))',
      "this.db.prepare(statements.insertSql)",
      'database!.prepare(("DELETE FROM t") as string)',
    ]) {
      expect({ call, findings: run(`${call}.run();\n`).findings.length }).toEqual({ call, findings: 1 });
    }
  });

  test("SQL held in a same-file constant of any name, or in a tagged template, is refused with its file and line (#4997)", () => {
    const cases = [
      ['const INSERT_ROW = "INSERT INTO session_drafts (draft_id) VALUES (?)";\nexport const insert = (db: Database, id: string) => db.prepare(INSERT_ROW).run(id);\n', 2],
      ['export function touch(db: Database, id: string) {\n  const stmt = "UPDATE session_drafts SET updated_at = 0 WHERE draft_id = ?";\n  db.prepare(stmt).run(id);\n}\n', 3],
      ["export const one = (db: Database) =>\n  db.prepare(String.raw`SELECT 1`).get();\n", 2],
    ] as const;
    expect(cases.map(([text]) => ({ text, findings: run(text).findings.map((f) => ({ file: f.file, line: f.line })) })))
      .toEqual(cases.map(([text, line]) => ({ text, findings: [{ file: FILE, line }] })));
  });
});

describe("what passes", () => {
  test("other objects' prepare methods take no SQL and are not flagged", () => {
    for (const text of [
      "await boundary.prepare();",
      "const before = operation.prepare(); if (!before.ok) throw before;",
      "await privateIndexes.prepare({ startupView, index, signal });",
      "const view = { startupView, index }; await privateIndexes.prepare(view);",
      "await options.execution.boundary.prepare(signal, startupView, timing);",
      "await this.settings.prepare(principal.id, { version: 1 });",
      "await combined.prepare(c.get(\"principal\")!, input, signal);",
      'const note = "await boundary.prepare() before admission"; // db.prepare("SELECT 1")',
      'db.query("UPDATE session_drafts SET updated_at = ? WHERE draft_id = ?").run(at, id);',
    ]) {
      expect({ text, findings: run(text).findings }).toEqual({ text, findings: [] });
    }
  });

  test("an allow-listed site passes and is listed with its reason", () => {
    const allow = [{ file: FILE, match: /^"SELECT 1 FROM t WHERE id = \?"$/, reason: "kept for the store's lifetime" }];
    const text = 'const once = db.prepare("SELECT 1 FROM t WHERE id = ?");\n';
    expect(run(text, FILE, allow)).toEqual({
      findings: [],
      allowed: [{ file: FILE, line: 1, column: 17, sql: '"SELECT 1 FROM t WHERE id = ?"', reason: "kept for the store's lifetime" }],
      unmatched: [],
    });
    // The entry covers its own SQL only: another statement in the same file is still refused.
    expect(run(`${text}db.prepare("DELETE FROM t").run();\n`, FILE, allow).findings.map((f) => f.line)).toEqual([2]);
  });

  test("an entry that matches no site, or more than one, is reported as stale", () => {
    const allow = [{ file: FILE, match: /^"SELECT 1/, reason: "kept for the store's lifetime" }];
    expect(run("db.query(\"SELECT 1\").get();\n", FILE, allow).unmatched).toEqual(allow);
    expect(run('db.prepare("SELECT 1").get();\ndb.prepare("SELECT 1 + 1").get();\n', FILE, allow).unmatched).toEqual(allow);
  });
});

describe("the tree", () => {
  test("ui-server source on main is clean, and every allowed site is matched once and names a reason", () => {
    const result = scanTree(ROOT);
    expect({ findings: result.findings, unmatched: result.unmatched }).toEqual({ findings: [], unmatched: [] });
    expect(result.allowed.length).toBe(ALLOWED.length);
    for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(20);
  });
});
