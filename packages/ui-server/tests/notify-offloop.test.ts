/** The Activity notifier and push bookkeeping commit on the write worker (#2850). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createOffloopNotifier, type WatchedScopes } from "../src/activity/notify-writes.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { createActivityRuntime } from "../src/activity/runtime.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { watchWriteSites } from "./helpers/write-sites.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "notify-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db);
  const logs: string[] = [];
  const failures: string[] = [];
  const log = { emit: (record: { body?: unknown; attributes?: { error?: unknown } }) => {
    logs.push(String(record.body));
    if (record.attributes?.error !== undefined) failures.push(`${String(record.body)}: ${String(record.attributes.error)}`);
  } } as unknown as Logger;
  return { root, db, writer, log, logs, failures, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
/** A failed root turn, recorded on the app connection before the watch starts. */
function failedTurn(f: ReturnType<typeof fixture>, runId: string, sessionId: string) {
  const store = createActivityStore(f.db, { writer: "odysseus" });
  store.startSpan({ runId, spanId: `${runId}:root`, name: "invoke_agent", kind: "turn", origin: "session", sessionId });
  store.endSpan(`${runId}:root`, { outcome: "error" });
}
const nobody: WatchedScopes = { index: false, runs: [], sessions: [] };

test("notifier ticks and delivery writes commit on the write worker at FULL, never on the app connection", async () => {
  const f = fixture();
  try {
    failedTurn(f, "voyage", "ithaca");
    failedTurn(f, "return", "troy");
    let watched: WatchedScopes = { index: false, runs: [], sessions: ["troy"] };
    const sites = await watchWriteSites(f.db, f.writer, ["notification_intents", "settings"]);
    const { notifier } = createOffloopNotifier(f.db, f.writer, { watched: () => watched, log: f.log });
    await notifier.tick();
    watched = nobody;
    expect(f.failures, "NOTIFY_TICK_COMMITS_ON_WORKER_AT_FULL").toEqual([]);
    const intents = notifier.inbox();
    expect(intents.map(intent => [intent.runId, intent.status]).sort(), "NOTIFY_TICK_COMMITS_ON_WORKER_WITH_WATCHED_SNAPSHOT")
      .toEqual([["return", "suppressed"], ["voyage", "pending"]]);
    expect(f.logs.filter(body => body === "notification intent created"), "NOTIFY_TICK_LOGS_REACH_THE_APP").toHaveLength(2);
    const voyage = intents.find(intent => intent.runId === "voyage")!;
    await notifier.markDelivered(voyage.id, "sent");
    expect(notifier.pending(), "NOTIFY_DELIVERED_COMMITS_ON_WORKER").toEqual([]);
    expect(await notifier.acknowledge(voyage.id), "NOTIFY_ACK_COMMITS_ON_WORKER").toBe(true);
    // `changes` counts the watch's own trigger rows, so read the result back.
    expect(await notifier.acknowledgeAll(), "NOTIFY_ACK_ALL_COMMITS_ON_WORKER").toBeGreaterThan(0);
    expect(notifier.inbox(), "NOTIFY_ACK_ALL_COMMITTED").toEqual([]);
    expect(await notifier.pruneAcknowledged(0), "NOTIFY_PRUNE_COMMITS_ON_WORKER").toBeGreaterThanOrEqual(0);
    const log = await sites.log();
    expect(new Set(log), "NOTIFY_TABLES_WRITTEN_ON_WORKER").toEqual(new Set(["notification_intents", "settings"]));
  } finally { await f.close(); }
});

test("a tick still committing is not submitted again", async () => {
  const f = fixture();
  try {
    const { notifier } = createOffloopNotifier(f.db, f.writer, { watched: () => nobody, log: f.log });
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const first = notifier.tick(), second = notifier.tick();
    expect(second, "NOTIFY_PENDING_TICK_NOT_RESUBMITTED").toBe(first);
    await slow; await first;
    expect(notifier.tick(), "NOTIFY_NEXT_TICK_RUNS_AFTER_IT").not.toBe(first);
  } finally { await f.close(); }
});

test("a delivery pass settles after its bookkeeping commits, so the next pass never resends", async () => {
  const f = fixture();
  try {
    const athena = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
    for (const endpoint of ["https://push.invalid/ithaca", "https://push.invalid/troy"])
      f.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id) VALUES (?, 'k', 'a', 0, ?)").run(endpoint, athena.id);
    failedTurn(f, "voyage", "ithaca");
    const sites = await watchWriteSites(f.db, f.writer, ["notification_intents", "push_subscriptions"]);
    const { notifier, push } = createOffloopNotifier(f.db, f.writer, { watched: () => nobody, log: f.log });
    await notifier.tick();
    const sender = createPushSender(f.db, { log: f.log, writes: push,
      send: async sub => { if (sub.endpoint.endsWith("troy")) throw Object.assign(new Error("gone"), { statusCode: 410 }); } });
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    await sender.deliverPending(notifier);
    expect(notifier.pending(), "PUSH_PASS_SETTLES_AFTER_DELIVERY_COMMITS").toEqual([]);
    expect(f.db.query("SELECT endpoint FROM push_subscriptions").all(), "PUSH_GONE_SUBSCRIPTION_DROPPED_BEFORE_SETTLING").toEqual([{ endpoint: "https://push.invalid/ithaca" }]);
    await slow;
    expect((f.db.query("SELECT last_used_at AS at FROM push_subscriptions").get() as { at: number | null }).at, "PUSH_SUBSCRIPTION_TOUCHED").not.toBeNull();
    expect(new Set(await sites.log()), "PUSH_TABLES_WRITTEN_ON_WORKER").toEqual(new Set(["notification_intents", "push_subscriptions"]));
  } finally { await f.close(); }
});

test("the Activity runtime ticks its notifier on the write worker when it has one", async () => {
  const f = fixture();
  const runtime = createActivityRuntime(f.db, { log: f.log, writer: f.writer });
  try {
    failedTurn(f, "voyage", "ithaca");
    await watchWriteSites(f.db, f.writer, ["notification_intents", "settings"]);
    await runtime.notifier.tick();
    expect(runtime.notifier.inbox().map(intent => intent.runId), "NOTIFY_RUNTIME_TICKS_ON_WORKER").toEqual(["voyage"]);
  } finally { runtime.close(); await f.close(); }
});
