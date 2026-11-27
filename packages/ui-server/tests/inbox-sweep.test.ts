/** The lifecycle sweep and the Actions cap read only rows that can need work (#4804). */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createUiDb } from "../src/db/client.js";
import { enforceInboxActionCap, enqueueInboxCleanup, sweepInboxLifecycle } from "../src/inbox/actions.js";
import { createInboxStore } from "../src/inbox/store.js";
import { inboxFixture, seedEverySweepBranch, SEEDED_AT, SWEEP_AT } from "./helpers/inbox-sweep-fixture.js";
import { queryPlan, recordStatements } from "./helpers/statement-recorder.js";

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/inbox-sweep.golden.json", import.meta.url), "utf8"));

/** `threads` finished threads whose staging cleanup is already queued, plus resolved decisions. */
function seedFinished(db: Database, threads: number) {
  const f = inboxFixture(db);
  db.transaction(() => {
    for (let i = 0; i < threads; i++) {
      const id = `voyage-${String(i).padStart(4, "0")}`;
      f.finish(f.thread(id));
      enqueueInboxCleanup(db, id, SEEDED_AT);
      if (i % 10 === 0) { f.action(id, `decided-${id}`); f.move(`decided-${id}`, "dismissed"); }
    }
  })();
  return f;
}

/** Statements and rows one call runs on `db`. */
function cost(db: Database, run: (db: Database) => void) {
  const recorded = recordStatements(db);
  run(recorded.db);
  return { statements: recorded.statements.length, rows: recorded.statements.reduce((sum, statement) => sum + (statement.rows ?? 0), 0) };
}

test("one sweep runs the same statements over 20 and over 2,000 finished items, and still readies due work", () => {
  const sweep = (finished: number) => {
    const db = createUiDb(":memory:");
    try {
      const f = seedFinished(db, finished);
      f.thread("helios");
      f.store.commit([{ kind: "item", item: { id: "schedule-helios", dedupKey: "schedule-helios", threadId: "helios", queue: "queue", type: "execute", status: "scheduled",
        attempts: 0, maxAttempts: 3, version: 1, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, expiresAt: SEEDED_AT + 86_400_000, waitUntil: SEEDED_AT + 60_000,
        payload: { instruction: "Herd the cattle of the sun" } } }]);
      const spent = cost(db, recorded => sweepInboxLifecycle(recorded, SWEEP_AT));
      return { ...spent, due: createInboxStore(db).getItem("schedule-helios")?.status };
    } finally { db.close(); }
  };
  const few = sweep(20), many = sweep(2_000);
  expect([few.due, many.due]).toEqual(["ready", "ready"]);
  expect(many).toEqual(few);
});

test("a second sweep over finished work whose cleanup exists costs no more than a sweep with nothing finished", () => {
  const finished = createUiDb(":memory:"), idle = createUiDb(":memory:");
  try {
    const f = inboxFixture(finished);
    f.finish(f.thread("ithaca"));
    sweepInboxLifecycle(finished, SWEEP_AT);
    expect(finished.query("SELECT COUNT(*) AS n FROM inbox_items WHERE type = 'cleanup_pending'").get()).toEqual({ n: 1 });
    const again = cost(finished, recorded => sweepInboxLifecycle(recorded, SWEEP_AT));
    inboxFixture(idle).thread("ogygia");
    const nothing = cost(idle, recorded => sweepInboxLifecycle(recorded, SWEEP_AT));
    expect(again.statements).toBeLessThanOrEqual(nothing.statements);
  } finally { finished.close(); idle.close(); }
});

/**
 * The SQLite VM instructions one run of `sql` takes over a copy of `db`,
 * bound to `now`. Bun's driver reports no statement counters, so the copy is
 * opened read-only with the platform's own SQLite and read back with
 * `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)`.
 */
function vmSteps(db: Database, sql: string, now: number): { steps: number; rows: number } {
  const sqlite = dlopen(process.platform === "darwin" ? "libsqlite3.dylib" : "libsqlite3.so.0", {
    sqlite3_open_v2: { args: [FFIType.cstring, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    sqlite3_prepare_v2: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    sqlite3_bind_int64: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
    sqlite3_step: { args: [FFIType.ptr], returns: FFIType.i32 },
    sqlite3_stmt_status: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    sqlite3_finalize: { args: [FFIType.ptr], returns: FFIType.i32 },
    sqlite3_close: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const dir = mkdtempSync(join(tmpdir(), "inbox-sweep-steps-")), file = join(dir, "inbox.db");
  const text = (value: string) => Buffer.from(`${value}\0`);
  const handle = new BigUint64Array(1), statement = new BigUint64Array(1);
  try {
    writeFileSync(file, db.serialize());
    expect(sqlite.symbols.sqlite3_open_v2(text(file), ptr(handle), 1 /* SQLITE_OPEN_READONLY */, null)).toBe(0);
    const connection = Number(handle[0]) as never;
    try {
      expect(sqlite.symbols.sqlite3_prepare_v2(connection, text(sql), -1, ptr(statement), null)).toBe(0);
      const compiled = Number(statement[0]) as never;
      try {
        expect(sqlite.symbols.sqlite3_bind_int64(compiled, 1, BigInt(now))).toBe(0);
        let rows = 0, code: number;
        while ((code = sqlite.symbols.sqlite3_step(compiled)) === 100 /* SQLITE_ROW */) rows++;
        expect(code).toBe(101 /* SQLITE_DONE */);
        return { steps: sqlite.symbols.sqlite3_stmt_status(compiled, 4 /* SQLITE_STMTSTATUS_VM_STEP */, 0), rows };
      } finally { sqlite.symbols.sqlite3_finalize(compiled); }
    } finally { sqlite.symbols.sqlite3_close(connection); }
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("the candidate read does the same work over 20 and over 2,000 settled threads (#4897)", () => {
  const work = (threads: number) => {
    const db = createUiDb(":memory:");
    try {
      // Settled: finished work, and a staging cleanup that has run.
      const f = seedFinished(db, threads);
      db.transaction(() => {
        for (const { id } of db.query("SELECT id FROM inbox_items WHERE type = 'cleanup_pending'").all() as { id: string }[]) f.finish(id);
      })();
      const recorded = recordStatements(db);
      sweepInboxLifecycle(recorded.db, SWEEP_AT);
      const candidates = recorded.statements.find(statement => statement.sql.includes("UNION SELECT"));
      expect(candidates).toBeDefined();
      return vmSteps(db, candidates!.sql, SWEEP_AT);
    } finally { db.close(); }
  };
  const few = work(20), many = work(2_000);
  expect([few.rows, many.rows]).toEqual([0, 0]);
  expect(many.steps, "CANDIDATE_WORK_INDEPENDENT_OF_SETTLED_THREADS").toBe(few.steps);
});

test("inbox_cleanup_due holds exactly the triage items whose thread has no cleanup for them, by trigger and by backfill (#4897)", () => {
  const db = createUiDb(":memory:");
  try {
    // The predicate the candidate read used before the table existed.
    const uncleaned = () => (db.query(`SELECT t.id FROM inbox_items t WHERE t.queue = 'queue' AND t.type = 'triage' AND NOT EXISTS (
      SELECT 1 FROM inbox_items c WHERE c.thread_id = t.thread_id AND c.type = 'cleanup_pending'
        AND json_extract(c.data_json, '$.payload.stagingId') = json_extract(t.data_json, '$.payload.stagingId')) ORDER BY t.id`).all() as { id: string }[]).map(row => row.id);
    const due = () => (db.query("SELECT item_id AS id FROM inbox_cleanup_due ORDER BY item_id").all() as { id: string }[]).map(row => row.id);
    seedEverySweepBranch(db);
    const before = uncleaned();
    expect(before.length).toBeGreaterThan(0);
    expect(due(), "DUE_BY_TRIGGER_BEFORE_SWEEP").toEqual(before);
    sweepInboxLifecycle(db, SWEEP_AT);
    expect(uncleaned().length).toBeLessThan(before.length);
    expect(due(), "DUE_BY_TRIGGER_AFTER_SWEEP").toEqual(uncleaned());
    // The migration's own backfill rebuilds the same rows.
    const migration = readFileSync(new URL("../migrations/103_inbox_cleanup_due.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf("INSERT INTO inbox_cleanup_due"), migration.indexOf(";", migration.indexOf("INSERT INTO inbox_cleanup_due")) + 1);
    db.exec("DELETE FROM inbox_cleanup_due");
    db.exec(backfill);
    expect(due(), "DUE_BY_BACKFILL").toEqual(uncleaned());
  } finally { db.close(); }
});

test("the Actions cap reads only open decisions however much finished history is present, and still retires the lowest priority", () => {
  const enforce = (finished: number) => {
    const db = createUiDb(":memory:");
    try {
      const f = seedFinished(db, finished);
      for (const [thread, stakes] of [["troy", 3], ["aeaea", 1], ["scheria", 2]] as const) {
        f.thread(thread, SEEDED_AT + 30 * 86_400_000, stakes);
        f.action(thread, `action-${thread}`);
      }
      const spent = cost(db, recorded => enforceInboxActionCap(recorded, 2, SWEEP_AT));
      const open = (db.query("SELECT id FROM inbox_items WHERE id LIKE 'action-%' AND status = 'pending' ORDER BY id").all() as { id: string }[]).map(row => row.id);
      return { ...spent, open };
    } finally { db.close(); }
  };
  const few = enforce(20), many = enforce(2_000);
  expect(few.open).toEqual(["action-scheria", "action-troy"]);
  expect(many).toEqual(few);
});

test("the candidate read searches the ready index and never scans the inbox", () => {
  const db = createUiDb(":memory:");
  try {
    const recorded = recordStatements(db);
    sweepInboxLifecycle(recorded.db, SWEEP_AT);
    const candidates = recorded.statements.find(statement => statement.sql.includes("UNION SELECT id FROM inbox_items"));
    expect(candidates).toBeDefined();
    const steps = queryPlan(db, candidates!);
    // The one scan is of the due triage items, which holds no settled thread (#4897).
    expect(steps.filter(step => step.startsWith("SCAN "))).toEqual(["SCAN d USING COVERING INDEX inbox_cleanup_due_thread"]);
    expect(steps.filter(step => /^SEARCH inbox_items /.test(step)).every(step => step.includes("USING INDEX inbox_items_ready"))).toBe(true);
    // Finished work is read only from the threads of those due items.
    expect(steps.filter(step => /^SEARCH i /.test(step))).toEqual(["SEARCH i USING INDEX inbox_items_thread (thread_id=?)"]);
  } finally { db.close(); }
});

test("one sweep over every branch leaves the exact state the snapshot-driven sweep left", () => {
  for (const [name, cap] of [["uncapped", undefined], ["capped", 1]] as const) {
    const db = createUiDb(":memory:");
    try {
      seedEverySweepBranch(db);
      sweepInboxLifecycle(db, SWEEP_AT, cap);
      expect({ name, state: createInboxStore(db, { now: () => SWEEP_AT }).exportState() }).toEqual({ name, state: GOLDEN[name] });
    } finally { db.close(); }
  }
});
