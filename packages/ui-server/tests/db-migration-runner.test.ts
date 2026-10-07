import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join } from "path";

const TEST_DB = `/tmp/brain-ui-migration-runner-test-${process.pid}.db`;
const TEST_MIGRATIONS_DIR = `/tmp/brain-ui-test-migrations-${process.pid}`;

function cleanUp() {
  for (const suffix of ["", "-shm", "-wal"]) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  if (existsSync(TEST_MIGRATIONS_DIR)) {
    rmSync(TEST_MIGRATIONS_DIR, { recursive: true });
  }
}

// The migration directory is deliberately relative to the production module.
// Copy that exact module into a temporary package layout so custom SQL fixtures
// reach the real factory without editing shipped migrations or cloning its logic.
let fixtureRoot: string;
let createDatabase: typeof import("../src/db/client").createUiDb;
function runMigrations(_database: Database, _migrationsDir: string) {
  const migrated = createDatabase(TEST_DB);
  migrated.close();
}

describe("migration runner", () => {
  let db: Database;

  beforeEach(async () => {
    cleanUp();
    fixtureRoot = mkdtempSync("/tmp/brain-ui-migration-source-");
    const sourceDir = join(fixtureRoot, "src/db");
    mkdirSync(sourceDir, { recursive: true });
    copyFileSync(join(import.meta.dir, "../src/db/client.ts"), join(sourceDir, "client.ts"));
    // Link only fixture SQL, keeping the copied source's relative directory.
    const { symlinkSync } = await import("fs");
    symlinkSync(TEST_MIGRATIONS_DIR, join(fixtureRoot, "migrations"));
    ({ createUiDb: createDatabase } = await import(join(sourceDir, "client.ts")));
    mkdirSync(TEST_MIGRATIONS_DIR, { recursive: true });
    db = new Database(TEST_DB, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
  });

  afterEach(() => {
    db.close();
    cleanUp();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("creates _migrations table if not exists", () => {
    runMigrations(db, TEST_MIGRATIONS_DIR);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("applies a single migration", () => {
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);"
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);

    const applied = db.query("SELECT filename FROM _migrations").all() as any[];
    expect(applied).toHaveLength(1);
    expect(applied[0].filename).toBe("001_create_users.sql");
  });

  test("applies migrations in order", () => {
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);"
    );
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "002_add_email.sql"),
      "ALTER TABLE users ADD COLUMN email TEXT;"
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);

    // Both applied
    const applied = db.query("SELECT filename FROM _migrations ORDER BY id").all() as any[];
    expect(applied).toHaveLength(2);
    expect(applied[0].filename).toBe("001_create_users.sql");
    expect(applied[1].filename).toBe("002_add_email.sql");

    // Table has email column
    db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run("Alice", "alice@example.com");
    const user = db.query("SELECT * FROM users WHERE name = 'Alice'").get() as any;
    expect(user.email).toBe("alice@example.com");
  });

  test("skips already-applied migrations", () => {
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);"
    );

    // Apply once
    runMigrations(db, TEST_MIGRATIONS_DIR);

    // Add a second migration
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "002_add_email.sql"),
      "ALTER TABLE users ADD COLUMN email TEXT;"
    );

    // Apply again - should only apply 002
    runMigrations(db, TEST_MIGRATIONS_DIR);

    const applied = db.query("SELECT filename FROM _migrations ORDER BY id").all() as any[];
    expect(applied).toHaveLength(2);
  });

  test("handles empty migrations directory", () => {
    runMigrations(db, TEST_MIGRATIONS_DIR);
    const applied = db.query("SELECT COUNT(*) as n FROM _migrations").get() as any;
    expect(applied.n).toBe(0);
  });

  test("handles missing migrations directory gracefully", () => {
    rmSync(TEST_MIGRATIONS_DIR, { recursive: true });
    // Should not throw
    runMigrations(db, TEST_MIGRATIONS_DIR);
  });

  test("ignores non-.sql files", () => {
    writeFileSync(join(TEST_MIGRATIONS_DIR, "README.md"), "# Migrations");
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "001_test.sql"),
      "CREATE TABLE test (id INTEGER PRIMARY KEY);"
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);

    const applied = db.query("SELECT COUNT(*) as n FROM _migrations").get() as any;
    expect(applied.n).toBe(1);
  });

  test("records applied_at timestamp", () => {
    const before = Date.now();
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "001_test.sql"),
      "CREATE TABLE test (id INTEGER PRIMARY KEY);"
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);

    const row = db.query("SELECT applied_at FROM _migrations LIMIT 1").get() as any;
    expect(row.applied_at).toBeGreaterThanOrEqual(before);
    expect(row.applied_at).toBeLessThanOrEqual(Date.now());
  });

  test("the legacy-session migration advances the epoch exactly once", () => {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO settings (key, value, updated_at)
      VALUES ('auth.sessionsEpoch', '7', 1);
    `);
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "014_invalidate_legacy_sessions.sql"),
      readFileSync(
        join(import.meta.dir, "../migrations/014_invalidate_legacy_sessions.sql"),
        "utf8"
      )
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);
    expect(
      db.query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'").get()
    ).toEqual({ value: "8" });

    runMigrations(db, TEST_MIGRATIONS_DIR);
    expect(
      db.query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'").get()
    ).toEqual({ value: "8" });
  });

  test("the legacy-session migration creates the downgrade guard when absent", () => {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    writeFileSync(
      join(TEST_MIGRATIONS_DIR, "014_invalidate_legacy_sessions.sql"),
      readFileSync(
        join(import.meta.dir, "../migrations/014_invalidate_legacy_sessions.sql"),
        "utf8"
      )
    );

    runMigrations(db, TEST_MIGRATIONS_DIR);

    expect(
      db.query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'").get()
    ).toEqual({ value: "1" });
  });
});
