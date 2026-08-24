/**
 * The digest: window semantics (first run capped, labeled coverage), the
 * retention-floor coupling, self-exclusion from notable, and quiet empties.
 */
import { describe, expect, test } from "bun:test";

import { createActivityStore } from "../src/activity/store";
import {
  digestRetentionFloor,
  generateActivityDigest,
  latestActivityDigest,
} from "../src/activity/digest";
import { createUiDb } from "../src/db/client";

function seedRun(
  store: ReturnType<typeof createActivityStore>,
  runId: string,
  opts: { job?: string; outcome?: "success" | "error"; startedAt?: number; costUsd?: number }
) {
  store.startSpan({
    spanId: `${runId}:root`,
    runId,
    name: `cron ${opts.job ?? "sync"}`,
    kind: "cron",
    origin: "cron",
    jobName: opts.job ?? "sync",
    startedAt: opts.startedAt ?? Date.now() - 60_000,
  });
  store.endSpan(`${runId}:root`, {
    outcome: opts.outcome ?? "success",
    endedAt: (opts.startedAt ?? Date.now() - 60_000) + 30_000,
    usage: opts.costUsd !== undefined ? { costUsd: opts.costUsd } : undefined,
  });
  store.rollupRun(runId);
}

describe("activity digest", () => {
  test("summarizes the window, flags failures, persists, and advances the floor", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "test" });
    seedRun(store, "a", { costUsd: 0.5 });
    seedRun(store, "b", { job: "maintain", outcome: "error" });

    const now = Date.now();
    const digest = generateActivityDigest(db, now);
    expect(digest.runs).toBe(2);
    expect(digest.failures).toBe(1);
    expect(digest.costUsd).toBeCloseTo(0.5);
    expect(digest.notable.map((n) => n.jobName)).toEqual(["maintain"]);
    // First run ever: the window is capped, not unbounded.
    expect(now - digest.windowStart).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);

    expect(latestActivityDigest(db)!.generatedAt).toBe(now);
    // The floor is what pruning respects (spans newer than it survive).
    expect(digestRetentionFloor(db)).toBe(now);

    // The next window starts where this one ended.
    seedRun(store, "c", { startedAt: now + 1000 });
    const second = generateActivityDigest(db, now + 60_000);
    expect(second.windowStart).toBe(now);
    expect(second.runs).toBe(1);
  });

  test("the digest job's own runs are excluded from the summary", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "test" });
    seedRun(store, "d", { job: "digest", outcome: "error" });
    const digest = generateActivityDigest(db);
    expect(digest.runs).toBe(0);
    expect(digest.notable).toHaveLength(0);
  });

  test("an empty window produces a quiet zero digest", () => {
    const db = createUiDb(":memory:");
    const digest = generateActivityDigest(db);
    expect(digest.runs).toBe(0);
    expect(digest.failures).toBe(0);
  });

  test("pruning respects the digest floor and the ceiling overrides a frozen one", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "test" });
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    seedRun(store, "old", { startedAt: old });
    // Digest never ran (floor 0): the floor protects everything...
    let res = store.prune({ digestFloorMs: digestRetentionFloor(db), hardCeilingMs: 90 * 24 * 60 * 60 * 1000 });
    expect(res.runsPruned).toBe(0);
    // ...until the digest covers it.
    generateActivityDigest(db);
    res = store.prune({ digestFloorMs: digestRetentionFloor(db), hardCeilingMs: 90 * 24 * 60 * 60 * 1000 });
    expect(res.runsPruned).toBe(1);
  });
});
