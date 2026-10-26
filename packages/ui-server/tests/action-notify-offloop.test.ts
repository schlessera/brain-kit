/** Action notice writes keep their transactions on the shared write worker (#3000). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Logger } from "@opentelemetry/api-logs";
import type { InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";

import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityRuntime } from "../src/activity/runtime.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createActionNotifier } from "../src/inbox/notify.js";
import { createOffloopActionNotifier } from "../src/inbox/notify-writes.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { createPushRoutes } from "../src/routes/push.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import type { AppEnv } from "../src/app-env.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import { watchWriteSites } from "./helpers/write-sites.js";

const AT = Date.UTC(2026, 6, 12, 9), YEAR = 365 * 24 * 60 * 60 * 1000;
const ENDPOINT = "https://push.example.test/ithaca";
const TABLES = ["inbox_notice_batches", "inbox_notice_constituents", "inbox_notice_attempts",
  "inbox_notice_attempt_components", "inbox_notice_clients", "inbox_notice_digests", "inbox_notice_coverage", "push_subscriptions"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "action-notify-odysseus-"));
  const db = createUiDb(join(root, "ui.db"));
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: YEAR / 1000 });
  const client = { principalId: principal.id, clientId: "ithaca" };
  db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id) VALUES (?, 'k', 'a', ?, ?)")
    .run(ENDPOINT, AT, principal.id);
  const store = createInboxStore(db, { now: () => AT });
  for (const [id, stakes, type] of [["sail", 3, "approve"], ["rope", 1, "choose"], ["omens", 1, "fyi"]] as const) {
    store.ingest({ threadId: id, itemId: `${id}-triage`, source: "cli", dedupKey: `${id}-triage`, stagingId: `${id}-staging`, expiresAt: AT + YEAR, stakes });
    const item: InboxActionItem = { id, dedupKey: id, threadId: id, queue: "actions", type, status: "pending", version: 1,
      createdAt: AT, updatedAt: AT, expiresAt: AT + YEAR,
      payload: { title: `Odysseus: ${id}`, detail: "Decide before the fleet sails." },
      options: type === "fyi" ? [] : [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] };
    store.commit([{ kind: "item", item }]);
  }
  // All inbox transitions, episodes and subscriptions precede the connection guard.
  const inline = createActionNotifier(db);
  inline.reportZone(client, "Europe/Athens", ENDPOINT, AT);
  const writer = openSqliteWriter(db);
  const failures: string[] = [];
  const runtime = createActivityRuntime(db, { writer, log: { emit(record: { body?: unknown; attributes?: { error?: unknown } }) {
    if (record.attributes?.error !== undefined) failures.push(`${String(record.body)}: ${String(record.attributes.error)}`);
  } } as unknown as Logger });
  return { db, writer, runtime, inline, client, principal, failures, destination: { endpoint: ENDPOINT, principalId: principal.id },
    notices: runtime.actionNotices,
    async close() { runtime.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof fixture>;
const writes: Array<{
  name: string;
  prepare?: (f: Fixture) => number | void;
  run: (f: Fixture, id: number | void) => unknown;
  tables: string[];
}> = [
  { name: "ENROLL", run: f => f.notices.enroll(AT), tables: ["inbox_notice_batches", "inbox_notice_constituents"] },
  { name: "BEGIN_ATTEMPT", prepare: f => { f.inline.enroll(AT); },
    run: f => f.notices.beginAttempt(f.destination, AT + 60_000), tables: ["inbox_notice_attempts", "inbox_notice_attempt_components"] },
  { name: "FINISH_ATTEMPT", prepare: f => { f.inline.enroll(AT); return f.inline.beginAttempt(f.destination, AT + 60_000)!.attemptId; },
    run: (f, id) => f.notices.finishAttempt(id!, "success", AT + 60_000), tables: ["inbox_notice_attempts"] },
  { name: "REPORT_ZONE", run: f => f.notices.reportZone(f.client, "UTC", ENDPOINT, AT), tables: ["inbox_notice_clients", "push_subscriptions"] },
  { name: "REPORT_DEVICE_ZONE", run: f => f.notices.reportDeviceZone(f.client.principalId, ENDPOINT, "UTC", AT), tables: ["push_subscriptions"] },
  { name: "DIGEST", run: f => f.notices.digest(f.client, AT), tables: ["inbox_notice_digests", "inbox_notice_coverage"] },
  { name: "DISMISS", run: f => f.notices.dismiss(f.client, AT, AT), tables: ["inbox_notice_clients"] },
  { name: "GENERATE_DUE", run: f => f.notices.generateDue(AT), tables: ["inbox_notice_digests", "inbox_notice_coverage"] },
];

for (const write of writes) test(`action notice ${write.name} commits on the write worker at FULL`, async () => {
  const f = fixture();
  try {
    const id = write.prepare?.(f);
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    let failure: unknown;
    try { await write.run(f, id); } catch (error) { failure = error; }
    expect(failure, `ACTION_NOTICE_${write.name}_COMMITS_ON_WORKER_AT_FULL`).toBeUndefined();
    expect(new Set(await sites.log()), `ACTION_NOTICE_${write.name}_WRITTEN_TABLES`).toEqual(new Set(write.tables));
  } finally { await f.close(); }
});

test("action notice writes keep submission order with Activity and other worker procedures", async () => {
  const f = fixture();
  try {
    const other = f.writer.channel(probe, { table: "odysseus_order" });
    await other.ready;
    const sites = await watchWriteSites(f.db, f.writer, [...TABLES, "odysseus_order", "activity_spans"]);
    const before = other.call("slow", "Calypso", 300);
    const zone = f.notices.reportZone(f.client, "UTC", ENDPOINT, AT);
    const span = f.runtime.store.startSpan({ runId: "voyage", spanId: "voyage:root", name: "invoke_agent", kind: "turn", origin: "session" });
    const enroll = f.notices.enroll(AT);
    const after = other.call("log", "Ithaca");
    await Promise.all([before, zone, span, enroll, after]);
    expect(await sites.log(), "ACTION_NOTICE_SUBMISSION_ORDER_WITH_OTHER_WRITERS").toEqual([
      "odysseus_order", "inbox_notice_clients", "push_subscriptions", "activity_spans",
      "inbox_notice_batches", "inbox_notice_constituents", "odysseus_order",
    ]);
    expect(f.db.query("SELECT reported_at FROM inbox_notice_clients").get(), "ACTION_NOTICE_SUBMISSION_CLOCK_RETAINED")
      .toEqual({ reported_at: AT });
  } finally { await f.close(); }
});

test("an action notice tick still committing is not submitted again", async () => {
  const f = fixture();
  try {
    const actions = createOffloopActionNotifier(f.db, f.writer);
    const held = f.writer.channel(probe, { table: "odysseus_hold" });
    await held.ready;
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    const slow = held.call("slow", "Calypso", 300);
    const first = actions.tick(), second = actions.tick();
    expect(second, "ACTION_NOTICE_PENDING_TICK_NOT_RESUBMITTED").toBe(first);
    await slow;
    await first;
    expect(new Set(await sites.log()), "ACTION_NOTICE_TICK_COMMITS_ON_WORKER_AT_FULL").toEqual(new Set([
      "inbox_notice_batches", "inbox_notice_constituents", "inbox_notice_digests", "inbox_notice_coverage",
    ]));
    const next = actions.tick();
    expect(next, "ACTION_NOTICE_NEXT_TICK_AFTER_COMMIT").not.toBe(first);
    await next;
  } finally { await f.close(); }
});

test("the Activity interval submits its action notice tick to the write worker", async () => {
  const original = globalThis.setInterval;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!;
  let tick: (() => void) | undefined;
  Object.defineProperty(globalThis, "setInterval", {
    ...descriptor,
    value: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 20_000) tick = () => callback(...args);
      return Reflect.apply(original, globalThis, [callback, ms, ...args]);
    },
  });
  let f: Fixture | undefined;
  try {
    f = fixture();
    Object.defineProperty(globalThis, "setInterval", descriptor);
    // There is no transport in this cell; the due digest still has real contents.
    f.db.query("DELETE FROM push_subscriptions").run();
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    expect(tick).toBeDefined();
    tick!();
    await f.writer.idle();
    expect(f.failures, "ACTION_RUNTIME_TICK_COMMITS_ON_WORKER_AT_FULL").toEqual([]);
    expect(new Set(await sites.log()), "ACTION_RUNTIME_TICK_GENERATES_DIGEST").toEqual(new Set(["inbox_notice_digests", "inbox_notice_coverage"]));
  } finally { Object.defineProperty(globalThis, "setInterval", descriptor); await f?.close(); }
});

test("an action delivery commits its attempt before transport and its outcome before the pass settles", async () => {
  const f = fixture();
  try {
    f.inline.enroll(AT);
    const held = f.writer.channel(probe, { table: "odysseus_hold" });
    await held.ready;
    let slow: Promise<unknown> | undefined;
    let submitted: unknown;
    const sender = createPushSender(f.db, { send: async () => {
      submitted = f.db.query("SELECT outcome, count FROM inbox_notice_attempts").get();
      slow = held.call("slow", "Calypso", 300);
      throw Object.assign(new Error("push service refused"), { statusCode: 500 });
    } });
    sender.publicKey(); // Boot-only key setup is outside this slice's watched writes.
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    const before = held.call("slow", "Circe", 300);
    expect(await sender.deliverActions(f.notices, AT + 60_000)).toBe(1);
    expect(submitted, "ACTION_ATTEMPT_DURABLE_BEFORE_TRANSPORT").toEqual({ outcome: "in_flight", count: 1 });
    expect(f.db.query("SELECT outcome FROM inbox_notice_attempts").get(), "ACTION_DELIVERY_SETTLES_AFTER_ATTEMPT_COMMIT")
      .toEqual({ outcome: "failed" });
    expect(await sender.deliverActions(f.notices, AT + 60_001), "ACTION_DELIVERY_RETRY_SEES_COMMITTED_ATTEMPT").toBe(0);
    await before;
    await slow;
    expect(new Set(await sites.log()), "ACTION_DELIVERY_ATTEMPTS_COMMIT_ON_WORKER")
      .toEqual(new Set(["inbox_notice_attempts", "inbox_notice_attempt_components"]));
  } finally { await f.close(); }
});

test("Action routes return committed zones, digest contents and dismissals", async () => {
  const f = fixture();
  try {
    const sender = createPushSender(f.db, { send: async () => {} });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("principal", f.principal); await next(); });
    app.route("/", createPushRoutes({ sender, notices: f.notices }));
    app.route("/", createActivityRoutes({ db: f.db, store: f.runtime.store, actionNotices: f.notices }));
    const post = (path: string, body: unknown = {}) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const held = f.writer.channel(probe, { table: "odysseus_hold" });
    await held.ready;
    await watchWriteSites(f.db, f.writer, TABLES);
    const slow = held.call("slow", "Calypso", 300);
    expect(await (await post("/push/zone", { clientId: f.client.clientId, endpoint: ENDPOINT, timeZone: "UTC" })).json(),
      "ACTION_ZONE_ROUTE_AWAITS_COMMIT").toEqual({ ok: true, timeZone: "UTC" });
    expect(f.db.query("SELECT time_zone FROM push_subscriptions").get(), "ACTION_ZONE_ROUTE_DEVICE_COMMITTED")
      .toEqual({ time_zone: "UTC" });
    await slow;
    const response = await app.request(`/activity/digest?client=${f.client.clientId}`);
    const { actions } = await response.json();
    expect(response.status).toBe(200);
    expect(actions.status, "ACTION_DIGEST_ROUTE_AWAITS_RESULT").toBe("ready");
    expect(actions.latest.waiting.map((entry: { itemId: string }) => entry.itemId)).toEqual(["rope"]);
    expect(actions.latest.updates.map((entry: { itemId: string }) => entry.itemId)).toEqual(["omens"]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_notice_coverage").get()).toEqual({ n: 2 });
    const dismissed = await post(`/activity/digest/dismiss?client=${f.client.clientId}&through=${actions.latest.generatedAt}`);
    expect(dismissed.status).toBe(200);
    expect(f.db.query("SELECT dismissed_at FROM inbox_notice_clients").get(), "ACTION_DISMISS_ROUTE_AWAITS_COMMIT")
      .toEqual({ dismissed_at: actions.latest.generatedAt });
  } finally { await f.close(); }
});

test("Action zone refusals retain their Error class and invalid metadata stays missing", async () => {
  const f = fixture();
  try {
    const refusal = await expectRejection(f.notices.reportZone({ ...f.client, principalId: "absent" }, "UTC", ENDPOINT, AT),
      "Authentication required", "ACTION_ZONE_AUTH_REFUSAL_RETAINED");
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).name).toBe("Error");
    await expectRejection(f.notices.reportDeviceZone("absent", ENDPOINT, "UTC", AT), "Authentication required");
    expect(await f.notices.reportZone(f.client, () => "UTC", ENDPOINT, AT), "ACTION_INVALID_ZONE_METADATA_STAYS_MISSING")
      .toEqual({ timeZone: null });
    expect(await f.notices.digest(f.client, AT)).toEqual({ status: "zone_required" });
  } finally { await f.close(); }
});
