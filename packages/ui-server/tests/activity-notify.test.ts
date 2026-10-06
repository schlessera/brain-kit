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
import { LABEL_RUN_NAME } from "../src/labels/labeller";

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
  test("replays offline failures and never resurrects acknowledged intents on restart", () => {
    const { db, store, notifier } = setup();
    try {
      failCron(store, "before-tick", "first");
      const restarted = createActivityNotifier({ db, store, isWatched: () => false });
      restarted.tick();
      expect(restarted.inbox().map((i) => i.runId)).toEqual(["before-tick"]);
      restarted.acknowledgeAll();
      failCron(store, "offline", "second");
      const next = createActivityNotifier({ db, store, isWatched: () => false });
      next.tick();
      notifier.tick(); // An older instance also reads the persisted checkpoint.
      expect(next.inbox().map((i) => i.runId)).toEqual(["offline"]);
      db.query("DELETE FROM settings WHERE key = 'activity.notify.cursor'").run();
      next.tick(); // First upgrade replay with existing acknowledged intents.
      expect(next.inbox().map((i) => i.runId)).toEqual(["offline"]);
    } finally { db.close(); }
  });

  test("commits notification batches and their cursor atomically", () => {
    const { db, store, notifier } = setup();
    try {
      failCron(store, "first", "first");
      failCron(store, "second", "second");
      db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON notification_intents
        WHEN NEW.run_id = 'second' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      notifier.tick();
      expect(notifier.inbox()).toHaveLength(0);
      expect(db.query("SELECT value FROM settings WHERE key = 'activity.notify.cursor'").get()).toBeNull();
      db.exec("DROP TRIGGER fail_second");
      notifier.tick();
      expect(notifier.inbox()).toHaveLength(2);
    } finally { db.close(); }
  });

  test("drains more than one replay batch without losing failures", () => {
    const { db, store } = setup();
    try {
      for (let i = 0; i < 510; i++) failCron(store, `run-${i}`, `job-${i}`);
      const notifier = createActivityNotifier({ db, store, isWatched: () => false });
      for (let i = 0; i < 5; i++) notifier.tick();
      expect(notifier.inbox(1000)).toHaveLength(510);
    } finally { db.close(); }
  });

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

  test("a pill label run never pages, and never swallows its session's next turn failure (#1083)", () => {
    const { db, store, notifier } = setup();
    setSetting(db, "activity.watchdog.thresholdMs", 10 * 60 * 1000);
    const root = (runId: string, name: string, startedAt?: number) =>
      store.startSpan({ spanId: `${runId}:root`, runId, name, kind: "turn", origin: "session", sessionId: "sess-ithaca", startedAt });
    root("label-failed", LABEL_RUN_NAME);
    store.endSpan("label-failed:root", { outcome: "error", reason: "vendor unavailable" });
    root("label-stalled", LABEL_RUN_NAME, Date.now() - 20 * 60 * 1000);
    notifier.tick();
    expect(notifier.inbox()).toEqual([]);

    root("turn-failed", "invoke_agent");
    store.endSpan("turn-failed:root", { outcome: "error", reason: "boom" });
    notifier.tick();
    expect(notifier.inbox().map((i) => [i.runId, i.kind])).toEqual([["turn-failed", "failure"]]);
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

  test("a per-job watchdog override below the default threshold still fires", () => {
    const { db, store, notifier } = setup();
    setSetting(db, "activity.watchdog.thresholdMs", 45 * 60 * 1000);
    setSetting(db, "activity.watchdog.perJobMs", { sync: 5 * 60 * 1000 });
    const startedAt = Date.now() - 10 * 60 * 1000;
    // Over the override, under the default. The scan must use the smallest
    // effective threshold or this candidate is filtered before the per-job
    // check ever sees it.
    store.startSpan({
      spanId: "sync:root",
      runId: "sync-run",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
      startedAt,
    });
    // Same age, no override: the default threshold still governs it.
    store.startSpan({
      spanId: "scrape:root",
      runId: "scrape-run",
      name: "cron scrape",
      kind: "cron",
      origin: "cron",
      jobName: "scrape",
      startedAt,
    });
    notifier.tick();
    const stuck = notifier.inbox().filter((i) => i.kind === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.runId).toBe("sync-run");
  });

  test("a send_failed intent is retried after backoff until the attempt budget is spent", () => {
    const { db, store, notifier } = setup();
    failCron(store, "run-1");
    notifier.tick();
    const intent = notifier.pending()[0]!;

    const age = () =>
      db
        .query("UPDATE notification_intents SET updated_at = ? WHERE id = ?")
        .run(Date.now() - 6 * 60 * 1000, intent.id);

    for (let attempt = 1; attempt <= 3; attempt++) {
      notifier.markDelivered(intent.id, "send_failed");
      // Inside the backoff window the intent is not re-offered.
      expect(notifier.pending()).toHaveLength(0);
      age();
      // After the backoff it is offered again — until the budget is spent.
      expect(notifier.pending()).toHaveLength(attempt < 3 ? 1 : 0);
    }

    // The inbox — the guaranteed tier — still holds it regardless.
    expect(notifier.inbox()).toHaveLength(1);
  });

  test("a sent intent never re-enters the delivery queue", () => {
    const { db, store, notifier } = setup();
    failCron(store, "run-1");
    notifier.tick();
    const intent = notifier.pending()[0]!;
    notifier.markDelivered(intent.id, "sent");
    db.query("UPDATE notification_intents SET updated_at = ? WHERE id = ?").run(
      Date.now() - 6 * 60 * 1000,
      intent.id
    );
    expect(notifier.pending()).toHaveLength(0);
  });
});
