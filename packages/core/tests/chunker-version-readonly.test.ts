/**
 * Schema 10 adds `documents.chunker_version` (#426). A read-only connection
 * does not migrate, so a schema-9 database stays schema 9 until something
 * writes. No read path may select the new column: the first command after
 * an upgrade can be a read.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

test("search, stats and doctor read a schema-9 index that has not been migrated", async () => {
  const root = makeTempBrain();
  roots.push(root);
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);

  // Put the database back the way schema 9 left it.
  const db = new Database(join(root, "brain.db"));
  db.run("ALTER TABLE documents DROP COLUMN chunker_version");
  db.run("UPDATE index_metadata SET value = '9' WHERE key = 'schema_version'");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const search = await runCli(root, ["search", "ranger", "--json"]);
  expect(search.stderr).not.toContain("no such column");
  expect(search.code).toBe(0);
  expect(JSON.parse(search.stdout).results.length).toBeGreaterThan(0);

  const stats = await runCli(root, ["stats", "--json"]);
  expect(stats.stderr).not.toContain("no such column");
  expect(stats.code).toBe(0);

  const doctor = await runCli(root, ["doctor", "--json"]);
  expect(doctor.stdout + doctor.stderr).not.toContain("no such column");

  // Still schema 9: nothing above migrated it.
  const check = new Database(join(root, "brain.db"), { readonly: true });
  const cols = check.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
  check.close();
  expect(cols.some((c) => c.name === "chunker_version")).toBe(false);
}, 120_000);
