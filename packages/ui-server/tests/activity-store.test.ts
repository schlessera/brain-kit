import { describe, expect, test } from "bun:test";

import { createUiDb } from "../src/db/client.js";
import {
  createActivityStore,
  MAX_EVENT_PAYLOAD_BYTES,
  type ActivityStore,
} from "../src/activity/store.js";

function freshStore(writer?: string): { store: ActivityStore; db: ReturnType<typeof createUiDb> } {
  const db = createUiDb(":memory:");
  return { store: createActivityStore(db, { writer }), db };
}

function startTurn(store: ActivityStore, runId = "run-1", sessionId = "sess-1") {
  return store.startSpan({
    spanId: `${runId}-root`,
    runId,
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId,
  });
}

describe("activity store: spans and ordering", () => {
  test("span tree round-trips with per-run seq ordering", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "tool-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
      sessionId: "sess-1",
    });
    store.endSpan("tool-1", { outcome: "success" });
    store.endSpan("run-1-root", {
      outcome: "success",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01, model: "claude-fable-5" },
    });

    const snap = store.snapshotRun("run-1")!;
    expect(snap.spans.map((s) => s.spanId)).toEqual(["run-1-root", "tool-1"]);
    expect(snap.highWaterSeq).toBe(4); // two starts + two ends
    expect(snap.spans[1]!.parentSpanId).toBe("run-1-root");
    expect(snap.spans[0]!.usage.costUsd).toBe(0.01);

    const changes = store.changesSince(0);
    expect(changes.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(changes.map((c) => c.changeId)).size).toBe(4);
  });

  test("terminal state is write-once", () => {
    const { store } = freshStore();
    startTurn(store);
    expect(store.endSpan("run-1-root", { outcome: "error", reason: "boom" })).toBe(true);
    expect(store.endSpan("run-1-root", { outcome: "success" })).toBe(false);
    expect(store.getSpan("run-1-root")!.outcome).toBe("error");
    expect(store.patchSpan("run-1-root", { usage: { costUsd: 1 } })).toBe(false);
  });

  test("denied is a distinct outcome, wait boundary recorded", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "tool-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "execute_tool Bash",
      kind: "tool",
      origin: "session",
    });
    store.patchSpan("tool-1", { waitUntil: Date.now() });
    store.endSpan("tool-1", { outcome: "denied", reason: "user declined" });
    const span = store.getSpan("tool-1")!;
    expect(span.outcome).toBe("denied");
    expect(span.waitUntil).not.toBeNull();
  });

  test("cascade close cancels open children with reason", () => {
    const { store } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "sub-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "invoke_agent subagent",
      kind: "subagent",
      origin: "session",
    });
    store.startSpan({
      spanId: "sub-1-tool",
      runId: "run-1",
      parentSpanId: "sub-1",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
    });
    const closed = store.cascadeClose("run-1", "cancelled", "turn aborted");
    expect(closed).toBe(3);
    for (const id of ["run-1-root", "sub-1", "sub-1-tool"]) {
      const s = store.getSpan(id)!;
      expect(s.outcome).toBe("cancelled");
      expect(s.outcomeReason).toBe("turn aborted");
    }
  });

  test("events are append-only, indexed, and capped with a truncation marker", () => {
    const { store } = freshStore();
    startTurn(store);
    store.appendEvent("run-1-root", "text", "hello");
    const big = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 100);
    const capped = store.appendEvent("run-1-root", "text", big)!;
    expect(capped.eventIndex).toBe(1);
    expect(capped.truncated).toBe(true);
    expect((capped.payload as string).length).toBeLessThan(big.length);
    expect(store.appendEvent("nonexistent", "text", "x")).toBeNull();

    const snap = store.snapshotRun("run-1")!;
    expect(snap.events).toHaveLength(2);
    expect(snap.events.map((e) => e.eventIndex)).toEqual([0, 1]);
  });

  test("snapshot pins high-water seq and global cursor consistently", () => {
    const { store } = freshStore();
    startTurn(store, "run-a");
    startTurn(store, "run-b");
    const snap = store.snapshotRun("run-a")!;
    expect(snap.highWaterSeq).toBe(1); // run-a has one write
    expect(snap.changeCursor).toBe(2); // globally two writes happened
    const later = store.changesSince(snap.changeCursor);
    expect(later).toHaveLength(0);
  });
});

describe("activity store: two writers", () => {
  test("interleaved writers on one file never collide on per-run seq", () => {
    const path = `/tmp/activity-two-writer-${process.pid}-${Date.now()}.db`;
    const dbA = createUiDb(path);
    const dbB = createUiDb(path);
    const server = createActivityStore(dbA, { writer: "server" });
    const cron = createActivityStore(dbB, { writer: "cron" });

    startTurn(server, "turn-run");
    cron.startSpan({
      spanId: "cron-root",
      runId: "cron-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    server.startSpan({
      spanId: "turn-tool",
      runId: "turn-run",
      parentSpanId: "turn-run-root",
      name: "execute_tool Read",
      kind: "tool",
      origin: "session",
    });
    cron.endSpan("cron-root", { outcome: "success" });
    server.endSpan("turn-tool", { outcome: "success" });
    server.endSpan("turn-run-root", { outcome: "success" });

    // The server discovers the cron writer's run purely via the global cursor.
    const all = server.changesSince(0, 100);
    const cronChanges = all.filter((c) => c.runId === "cron-run");
    expect(cronChanges.map((c) => c.seq)).toEqual([1, 2]);
    const turnChanges = all.filter((c) => c.runId === "turn-run");
    expect(turnChanges.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    // Global cursor strictly increases across both writers.
    const ids = all.map((c) => c.changeId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    dbA.close();
    dbB.close();
  });
});

describe("activity store: rollups and retention", () => {
  test("rollup aggregates root-span usage only and survives pruning", () => {
    const { store, db } = freshStore();
    startTurn(store);
    store.startSpan({
      spanId: "sub-1",
      runId: "run-1",
      parentSpanId: "run-1-root",
      name: "invoke_agent subagent",
      kind: "subagent",
      origin: "session",
    });
    // Subagent usage present but must NOT be added to the rollup (the root's
    // result-level accounting already includes it).
    store.endSpan("sub-1", { outcome: "success", usage: { inputTokens: 999, costUsd: 5 } });
    store.endSpan("run-1-root", {
      outcome: "success",
      usage: { inputTokens: 1200, outputTokens: 300, costUsd: 1.02 },
    });
    store.rollupRun("run-1");

    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'run-1'")
      .get() as any;
    expect(rollup.cost_usd).toBe(1.02);
    expect(rollup.input_tokens).toBe(1200);
    expect(rollup.span_count).toBe(2);
    expect(rollup.detail_pruned).toBe(0);

    const res = store.prune({ digestFloorMs: Date.now() + 1000, hardCeilingMs: 0 });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("run-1")).toBeNull();
    const after = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'run-1'")
      .get() as any;
    expect(after.detail_pruned).toBe(1);
    expect(after.outcome).toBe("success");
  });

  test("prune never touches runs with open spans, hard ceiling marks coverage gap", () => {
    const { store, db } = freshStore();
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    store.startSpan({
      spanId: "old-root",
      runId: "old-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt: old,
    });
    store.endSpan("old-root", { outcome: "success", endedAt: old + 60_000 });
    // Prune candidates come from the rollups (every production terminal
    // path writes one); a bare endSpan in a test must roll up itself.
    store.rollupRun("old-run");
    startTurn(store, "live-run"); // stays open

    // Digest floor far in the past (digest broken) — only the ceiling prunes.
    const res = store.prune({ digestFloorMs: 0, hardCeilingMs: 90 * 24 * 60 * 60 * 1000 });
    expect(res.runsPruned).toBe(1);
    expect(store.snapshotRun("live-run")).not.toBeNull();
    const rollup = db
      .query("SELECT * FROM activity_run_rollups WHERE run_id = 'old-run'")
      .get() as any;
    expect(rollup.detail_pruned).toBe(1);
    expect(rollup.failure_reason).toBe("digest coverage gap");
  });
});
