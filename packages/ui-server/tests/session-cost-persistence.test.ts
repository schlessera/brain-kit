import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";
import { createUiDb } from "../src/db/client";
import { createSessionCatalog } from "../src/ws/session-catalog";

const TEST_DB = `/tmp/brain-ui-cost-test-${process.pid}.db`;

describe("session cost persistence", () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createUiDb(TEST_DB);
  });

  afterEach(() => {
    db.close();
    for (const s of ["", "-shm", "-wal"]) {
      if (existsSync(TEST_DB + s)) unlinkSync(TEST_DB + s);
    }
  });

  function upsertSession(id: string, title: string, costUsd: number, numTurns: number) {
    createSessionCatalog(() => db).persistSession({
      type: "result", sessionId: id, costUsd, numTurns,
      durationMs: 1, isError: false, outcome: "success",
    }, title, "fixture-profile", "fixture-backend");
  }

  test("inserts new session on first result", () => {
    upsertSession("s1", "Hello brain", 0.05, 3);

    const row = db.query("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(row).not.toBeNull();
    expect(row.title).toBe("Hello brain");
    expect(row.total_cost_usd).toBeCloseTo(0.05);
    expect(row.num_turns).toBe(3);
  });

  test("accumulates cost on subsequent results", () => {
    upsertSession("s1", "First query", 0.03, 2);
    upsertSession("s1", "Second query", 0.07, 1);

    const row = db.query("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(row.total_cost_usd).toBeCloseTo(0.10);
    expect(row.num_turns).toBe(3);
  });

  test("updates last_active_at on each result", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      upsertSession("s1", "Query", 0.01, 1);
      expect((db.query("SELECT last_active_at FROM sessions WHERE id = 's1'").get() as any).last_active_at).toBe(1_000);
      clock.mockReturnValue(2_000);
      upsertSession("s1", "Query 2", 0.01, 1);
      expect((db.query("SELECT last_active_at FROM sessions WHERE id = 's1'").get() as any).last_active_at).toBe(2_000);
    } finally { clock.mockRestore(); }
  });

  test("preserves original title (does not overwrite)", () => {
    upsertSession("s1", "Original question", 0.01, 1);
    upsertSession("s1", "Follow-up question", 0.02, 1);

    const row = db.query("SELECT title FROM sessions WHERE id = 's1'").get() as any;
    // ON CONFLICT DO UPDATE doesn't update title, so original is preserved
    expect(row.title).toBe("Original question");
  });

  test("handles zero-cost results", () => {
    upsertSession("s1", "Free query", 0, 0);
    const row = db.query("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(row.total_cost_usd).toBe(0);
    expect(row.num_turns).toBe(0);
  });

  test("multiple sessions tracked independently", () => {
    upsertSession("s1", "Session 1", 0.05, 2);
    upsertSession("s2", "Session 2", 0.10, 3);

    const r1 = db.query("SELECT total_cost_usd FROM sessions WHERE id = 's1'").get() as any;
    const r2 = db.query("SELECT total_cost_usd FROM sessions WHERE id = 's2'").get() as any;
    expect(r1.total_cost_usd).toBeCloseTo(0.05);
    expect(r2.total_cost_usd).toBeCloseTo(0.10);
  });
});
