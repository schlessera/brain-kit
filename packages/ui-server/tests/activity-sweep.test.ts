import { describe, expect, test } from "bun:test";

import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";

describe("activity store: sweepers", () => {
  test("boot sweep closes session-origin orphans as interrupted, children included", () => {
    const path = `/tmp/activity-sweep-${process.pid}-${Date.now()}.db`;
    const dbBefore = createUiDb(path);
    const before = createActivityStore(dbBefore, { writer: "server-old" });
    before.startSpan({
      spanId: "root",
      runId: "run-1",
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      sessionId: "s1",
    });
    before.startSpan({
      spanId: "tool",
      runId: "run-1",
      parentSpanId: "root",
      name: "execute_tool Bash",
      kind: "tool",
      origin: "session",
    });
    dbBefore.close(); // process died mid-turn

    const dbAfter = createUiDb(path);
    const after = createActivityStore(dbAfter, { writer: "server-new" });
    const closed = after.sweepOwnOrphans();
    expect(closed).toBe(2);
    expect(after.getSpan("root")!.outcome).toBe("interrupted");
    expect(after.getSpan("tool")!.outcome).toBe("interrupted");
    // Rollup exists so the run stays resolvable.
    const rollup = dbAfter
      .query("SELECT outcome FROM activity_run_rollups WHERE run_id = 'run-1'")
      .get() as any;
    expect(rollup.outcome).toBe("interrupted");
    dbAfter.close();
  });

  test("boot sweep leaves cron-origin spans alone", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server" });
    store.startSpan({
      spanId: "cron-root",
      runId: "cron-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    expect(store.sweepOwnOrphans()).toBe(0);
    expect(store.getSpan("cron-root")!.outcome).toBeNull();
  });

  test("staleness is judged on heartbeat age, not span age", () => {
    const db = createUiDb(":memory:");
    const server = createActivityStore(db, { writer: "server" });
    const cronDb = createActivityStore(db, { writer: "cron" });
    const longAgo = Date.now() - 60 * 60 * 1000;
    cronDb.startSpan({
      spanId: "long-root",
      runId: "long-run",
      name: "cron maintain",
      kind: "cron",
      origin: "cron",
      jobName: "maintain",
      startedAt: longAgo,
    });
    // A long-running but ALIVE job: heartbeat is fresh, span is old.
    cronDb.heartbeat("long-root");
    expect(server.sweepStale(2 * 60 * 1000)).toBe(0);
    expect(server.getSpan("long-root")!.outcome).toBeNull();

    // Writer dies: heartbeat goes stale, sweep closes it.
    const now = Date.now() + 10 * 60 * 1000;
    expect(server.sweepStale(2 * 60 * 1000, now)).toBe(1);
    expect(server.getSpan("long-root")!.outcome).toBe("interrupted");
  });

  test("staleness sweep never closes this writer's own rows", () => {
    const db = createUiDb(":memory:");
    const server = createActivityStore(db, { writer: "server" });
    server.startSpan({
      spanId: "own-root",
      runId: "own-run",
      name: "invoke_agent",
      kind: "turn",
      origin: "session",
      startedAt: Date.now() - 60 * 60 * 1000,
    });
    expect(server.sweepStale(60 * 1000)).toBe(0);
    expect(server.getSpan("own-root")!.outcome).toBeNull();
  });

  test("watchdog flags over-threshold live roots without closing them", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "server" });
    store.startSpan({
      spanId: "slow-root",
      runId: "slow-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt: Date.now() - 45 * 60 * 1000,
    });
    const stuck = store.findStuck(30 * 60 * 1000);
    expect(stuck.map((s) => s.runId)).toEqual(["slow-run"]);
    expect(store.getSpan("slow-root")!.outcome).toBeNull();
    expect(store.findStuck(60 * 60 * 1000)).toHaveLength(0);
  });
});
