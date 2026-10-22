/**
 * The disposable index lives in `.brain-index/` (#1668, option B). A brain
 * from an earlier release migrates by rebuilding: the old root-level copy is
 * never read, never moved, and `brain doctor --fix` deletes it.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { INDEX_DB_PATH } from "@schlessera/brain-common/internal/index-location";
import { initContext, setContext } from "../src/lib/context";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
function tempBrain(): string {
  const dir = makeTempBrain();
  temps.push(dir);
  return dir;
}
afterEach(() => {
  setContext(null);
  while (temps.length) cleanup(temps.pop()!);
});

/** A root-level index an earlier release left: a real SQLite file naming a document nothing on disk has. */
function legacyIndex(root: string): void {
  const db = new Database(join(root, "brain.db"));
  db.run("CREATE TABLE odysseus_legacy(body TEXT)");
  db.run("INSERT INTO odysseus_legacy VALUES ('Penelope keeps the loom unfinished')");
  db.close();
  writeFileSync(join(root, "brain.db-wal"), "");
}

test("the context resolves the index inside .brain-index/", async () => {
  const root = tempBrain();
  const context = await initContext({ root });
  expect(context.dbPath, "CONTEXT_INDEX_IN_DIRECTORY").toBe(join(root, INDEX_DB_PATH));
});

test("brain index writes the index family into .brain-index/ and nothing into the root", async () => {
  const root = tempBrain();
  const { stdout, stderr, code } = await runCli(root, ["index", "--json"]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout).total).toBeGreaterThan(0);
  expect(lstatSync(join(root, ".brain-index")).isDirectory(), "INDEX_DIRECTORY_CREATED").toBe(true);
  expect(existsSync(join(root, INDEX_DB_PATH)), "INDEX_DATABASE_IN_DIRECTORY").toBe(true);
  for (const name of ["brain.db", "brain.db-wal", "brain.db-shm", "brain.db-journal"])
    expect(existsSync(join(root, name)), `NO_ROOT_LEVEL_${name}`).toBe(false);
});

test("a legacy root-level index is ignored: readers report no index until the rebuild", async () => {
  const root = tempBrain();
  legacyIndex(root);
  const before = readFileSync(join(root, "brain.db"));
  const search = await runCli(root, ["search", "Penelope", "--json"]);
  expect(search.code, "LEGACY_INDEX_NOT_READ").not.toBe(0);
  expect(search.stdout + search.stderr).toContain("brain index");
  const index = await runCli(root, ["index", "--json"]);
  expect(index.code, index.stderr).toBe(0);
  expect(existsSync(join(root, INDEX_DB_PATH)), "MIGRATION_REBUILDS_IN_DIRECTORY").toBe(true);
  expect(readFileSync(join(root, "brain.db")), "LEGACY_INDEX_NEVER_WRITTEN_OR_MOVED").toEqual(before);
});

test("doctor names the legacy index and --fix deletes it after the rebuild", async () => {
  const root = tempBrain();
  legacyIndex(root);
  const doctor = await runCli(root, ["doctor", "--json"]);
  const checks = Object.fromEntries((JSON.parse(doctor.stdout).checks as { id: string; status: string; detail: string }[]).map(check => [check.id, check]));
  expect(checks["legacy-index"]?.status, "LEGACY_INDEX_REPORTED").toBe("warn");
  expect(checks["legacy-index"]?.detail).toContain("brain.db, brain.db-wal");
  expect(checks["db"]?.detail, "MISSING_INDEX_NAMES_THE_MOVE").toContain("rebuilt, not moved");
  const fixed = await runCli(root, ["doctor", "--fix", "--json"]);
  expect(fixed.stdout + fixed.stderr).not.toContain("legacy-index fix failed");
  for (const name of ["brain.db", "brain.db-wal"]) expect(existsSync(join(root, name)), `LEGACY_${name}_DELETED`).toBe(false);
  expect(existsSync(join(root, INDEX_DB_PATH)), "FIX_REBUILT_THE_INDEX").toBe(true);
  const after = Object.fromEntries((JSON.parse((await runCli(root, ["doctor", "--json"])).stdout).checks as { id: string; status: string }[]).map(check => [check.id, check.status]));
  expect(after["legacy-index"], "LEGACY_INDEX_CHECK_PASSES_AFTER_FIX").toBe("pass");
});
