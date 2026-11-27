/** The lifecycle sweep and the Actions cap read only rows that can need work (#4804). */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
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
    expect(steps.filter(step => step.startsWith("SCAN "))).toEqual([]);
    expect(steps.filter(step => /^SEARCH (inbox_items|i) /.test(step)).every(step => step.includes("USING INDEX inbox_items_ready"))).toBe(true);
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
