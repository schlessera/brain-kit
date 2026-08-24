/**
 * Notification intents: at-least-once creation from terminal failures,
 * watched-suppression, tag dedupe, the failure-storm rate cap, the stuck
 * watchdog, and completion opt-in.
 */
import { describe, expect, test } from "bun:test";

import { createActivityStore, type ActivityStore } from "../src/activity/store";
import { createActivityNotifier, type ActivityNotifier } from "../src/activity/notify";
import { createUiDb } from "../src/db/client";
import { setSetting } from "../src/db/settings";

function setup(options?: { watched?: boolean }): {
  db: ReturnType<typeof createUiDb>;
  store: ActivityStore;
  notifier: ActivityNotifier;
} {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const notifier = createActivityNotifier({
    db,
    store,
    isWatched: () => options?.watched ?? false,
  });
  return { db, store, notifier };
}

function failCron(store: ActivityStore, runId: string, jobName = "sync") {
  store.startSpan({
    spanId: `${runId}:root`,
    runId,
    name: `cron ${jobName}`,
    kind: "cron",
    origin: "cron",
    jobName,
  });
  store.endSpan(`${runId}:root`, { outcome: "error", reason: "boom" });
}

describe("activity notifier", () => {
  test("an unwatched failure becomes a pending intent, delivered at-least-once", () => {
    const { store, notifier } = setup();
    failCron(store, "run-1");
    notifier.tick();

    const inbox = notifier.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe("failure");
    expect(inbox[0]!.status).toBe("pending");
    expect(inbox[0]!.title).toContain("sync");
    // Payload minimization: no stderr text in the notification body.
    expect(inbox[0]!.body).not.toContain("boom");

    // "Server died before sending": a NEW notifier over the same DB still
    // sees the pending intent — the sweep is just reading it.
    expect(notifier.pending()).toHaveLength(1);
  });

  test("a watched failure is suppressed for delivery but stays in the inbox", () => {
    const { store, notifier } = setup({ watched: true });
    failCron(store, "run-1");
    notifier.tick();
    const inbox = notifier.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.status).toBe("suppressed");
    expect(notifier.pending()).toHaveLength(0);
  });

  test("repeated failures of one job coalesce onto one live intent", () => {
    const { store, notifier } = setup();
    failCron(store, "run-1");
    notifier.tick();
    failCron(store, "run-2");
    failCron(store, "run-3");
    notifier.tick();
    expect(notifier.inbox()).toHaveLength(1);

    // Acknowledged: the NEXT failure may raise a fresh intent.
    notifier.acknowledge(notifier.inbox()[0]!.id);
    failCron(store, "run-4");
    notifier.tick();
    expect(notifier.inbox()).toHaveLength(1);
  });

  test("the global rate cap suppresses a failure storm", () => {
    const { store, notifier } = setup();
    for (let i = 0; i < 30; i++) {
      failCron(store, `run-${i}`, `job-${i}`); // distinct tags
    }
    notifier.tick();
    const all = notifier.inbox();
    expect(all.length).toBe(30);
    // The cap is exact: the first 20 creations pass, the rest suppress.
    const pending = all.filter((i) => i.status === "pending");
    const suppressed = all.filter((i) => i.status === "suppressed");
    expect(pending.length).toBe(20);
    expect(suppressed.length).toBe(10);
  });

  test("an acknowledged (dismissed) intent is never pushed later", () => {
    const { store, notifier } = setup();
    failCron(store, "run-1");
    notifier.tick();
    expect(notifier.pending()).toHaveLength(1);
    notifier.acknowledge(notifier.inbox()[0]!.id);
    expect(notifier.pending()).toHaveLength(0);
  });

  test("pruneAcknowledged deletes only old acknowledged intents", () => {
    const { db, store, notifier } = setup();
    failCron(store, "run-1");
    failCron(store, "run-2", "other");
    notifier.tick();
    notifier.acknowledge(notifier.inbox().find((i) => i.title.includes("sync"))!.id);
    // Age the acknowledged row past the cutoff.
    db.query(
      "UPDATE notification_intents SET updated_at = ? WHERE acknowledged = 1"
    ).run(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(notifier.pruneAcknowledged(30 * 24 * 60 * 60 * 1000)).toBe(1);
    // The unacknowledged intent survives regardless of age.
    expect(notifier.inbox()).toHaveLength(1);
  });

  test("interrupted runs notify too; successes do not by default", () => {
    const { store, notifier } = setup();
    store.startSpan({
      spanId: "a:root",
      runId: "a",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    store.endSpan("a:root", { outcome: "success" });
    store.startSpan({
      spanId: "b:root",
      runId: "b",
      name: "cron maintain",
      kind: "cron",
      origin: "cron",
      jobName: "maintain",
    });
    store.endSpan("b:root", { outcome: "interrupted", reason: "writer went silent" });
    notifier.tick();
    const inbox = notifier.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.title).toContain("maintain");
  });

  test("completion notifications are per-job opt-in", () => {
    const { db, store, notifier } = setup();
    setSetting(db, "activity.notify.completions", ["sync"]);
    store.startSpan({
      spanId: "a:root",
      runId: "a",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    store.endSpan("a:root", { outcome: "success" });
    notifier.tick();
    expect(notifier.inbox().map((i) => i.kind)).toEqual(["completion"]);
  });

  test("the watchdog flags an over-threshold live run once, without closing it", () => {
    const { db, store, notifier } = setup();
    setSetting(db, "activity.watchdog.thresholdMs", 10 * 60 * 1000);
    store.startSpan({
      spanId: "slow:root",
      runId: "slow",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt: Date.now() - 20 * 60 * 1000,
    });
    notifier.tick();
    notifier.tick();
    const inbox = notifier.inbox();
    expect(inbox.filter((i) => i.kind === "stuck")).toHaveLength(1);
    expect(store.getSpan("slow:root")!.outcome).toBeNull();
  });
});
