/**
 * Durable Action notices (U9) against the real notifier, the real push sender
 * and a local captured transport. Every clock is controlled; no network.
 * The examples are the binding ones in docs/decisions/action-notifications.md.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";

import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal, type Principal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { sweepInboxLifecycle } from "../src/inbox/actions.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { createActivityStore } from "../src/activity/store.js";
import { createPushRoutes } from "../src/routes/push.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import type { AppEnv } from "../src/app-env.js";
import {
  ACTION_NOTICE_WINDOW_MS,
  createActionNotifier,
  latestDigestSlot,
  noticeDestination,
  type ActionDigestSummary,
} from "../src/inbox/notify.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const HOUR = 3_600_000, DAY = 24 * HOUR, YEAR = 365 * DAY;
/** Europe/Athens is UTC+3 until 2026-10-25: a local wall time on 2026-10-03 + dayOffset. */
/** The principal-wide client context (no client identifier). */
const ctx = (p: { id: string }, clientId = "") => ({ principalId: p.id, clientId });
const athens = (dayOffset: number, hour: number, minute = 0, second = 0) =>
  Date.UTC(2026, 9, 3 + dayOffset, hour - 3, minute, second);

type Mode = "ok" | "fail" | "timeout" | "gone";

function world(options: { path?: string } = {}) {
  let path = options.path;
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), "brain-notify-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    path = join(dir, "ui.sqlite");
  }
  const db = createUiDb(path);
  cleanup.push(() => db.close());
  let clock = athens(0, 10);
  const store = createInboxStore(db, { now: () => clock });
  const modes = new Map<string, Mode>();
  const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const sender = createPushSender(db, {
    send: async (sub, payload) => {
      const mode = modes.get(sub.endpoint) ?? "ok";
      if (mode === "fail") throw Object.assign(new Error("push service refused"), { statusCode: 500 });
      if (mode === "gone") throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (mode === "timeout") throw new Error("socket hang up");
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    },
  });
  const notices = createActionNotifier(db, { now: () => clock });
  const principal = (label: string) => createPrincipal(db, { authMethod: "password", label, ttlSeconds: YEAR / 1000 });
  function device(owner: Principal, endpoint: string, zone?: string) {
    expect(sender.subscribe({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }, owner.id, endpoint)).toBe(true);
    if (zone !== undefined) notices.reportZone(ctx(owner), zone, endpoint, clock);
    return endpoint;
  }
  let threads = 0;
  function decision(id: string, input: { stakes: number; deadline?: number; thread?: string; type?: "approve" | "choose" | "fyi" }) {
    const threadId = input.thread ?? `thread-${++threads}`;
    if (!store.getThread(threadId)) {
      store.ingest({ threadId, itemId: `${threadId}-triage`, source: "cli", dedupKey: threadId, stagingId: `${threadId}-staging`,
        expiresAt: clock + YEAR, stakes: input.stakes, ...(input.deadline !== undefined ? { deadline: input.deadline } : {}) });
    }
    const type = input.type ?? "approve";
    const item: InboxActionItem = { id, dedupKey: id, threadId, queue: "actions", type, status: "pending", version: 1,
      createdAt: clock, updatedAt: clock, expiresAt: clock + YEAR,
      payload: { title: `Odysseus: ${id}`, detail: "Decide before the fleet sails." },
      options: type === "fyi" ? [] : [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] };
    store.commit([{ kind: "item", item }]);
    return id;
  }
  function move(id: string, to: "dismissed" | "snoozed" | "pending", waitUntil?: number) {
    const item = store.getItem(id)!;
    store.commit([{ kind: "transition", itemId: id, expectedVersion: item.version, to,
      ...(to === "snoozed" ? { waitUntil: waitUntil ?? clock + HOUR } : {}), ...(to === "pending" ? { waitUntil: null } : {}) }]);
  }
  /** One server tick at `at`: enroll eligible work, then deliver due notices. */
  async function tick(at: number) {
    clock = at;
    notices.enroll(at);
    const before = sent.length;
    await sender.deliverActions(notices, at);
    return sent.slice(before);
  }
  const attempts = () => db.query(
    "SELECT destination, principal_id, outcome, count, payload_json FROM inbox_notice_attempts ORDER BY id"
  ).all() as Array<{ destination: string; principal_id: string; outcome: string; count: number; payload_json: string }>;
  return {
    db, store, sender, notices, modes, sent, principal, device, decision, move, tick, attempts, path,
    set now(value: number) { clock = value; },
    get now() { return clock; },
  };
}

test("0/20/50-second arrivals across threads form one three-decision notice at 60 seconds", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus"), penelope = w.principal("Penelope");
  const phone = w.device(odysseus, "https://push.example.test/odysseus-phone", "Europe/Athens");
  const loom = w.device(penelope, "https://push.example.test/penelope-loom", "Europe/Athens");
  const start = athens(0, 10);
  w.now = start;
  w.decision("raft", { stakes: 3, thread: "ogygia" });
  expect(await w.tick(start)).toEqual([]);
  w.now = start + 10_000;
  // Stakes belong to the thread. Score 8 is digest class and cannot piggyback.
  w.decision("tribute", { stakes: 2, thread: "aeaea" });
  w.decision("weather", { stakes: 3, type: "fyi", thread: "ogygia" }); // FYI never counts
  w.now = start + 20_000;
  w.decision("sail", { stakes: 3, thread: "ogygia" });
  expect(await w.tick(start + 20_000)).toEqual([]);
  w.now = start + 50_000;
  w.decision("cattle", { stakes: 3, thread: "thrinacia" });
  expect(await w.tick(start + 50_000)).toEqual([]);
  expect(await w.tick(start + 59_999)).toEqual([]);

  const first = await w.tick(start + ACTION_NOTICE_WINDOW_MS);
  // One notice per recipient principal's destination; principals never mix.
  expect(first.map((s) => s.endpoint).sort()).toEqual([loom, phone].sort());
  for (const notice of first) {
    // Lock-screen minimized: count and the Actions deep link, no thread content.
    expect(notice.payload).toEqual({ title: "3 actions waiting", body: "Open Actions to decide.", tag: "brain-actions", url: "/#/activity" });
  }
  const constituents = w.db.query(
    "SELECT principal_id, item_id, thread_id FROM inbox_notice_constituents ORDER BY principal_id, item_id"
  ).all() as Array<{ principal_id: string; item_id: string; thread_id: string }>;
  expect(constituents.filter((c) => c.principal_id === odysseus.id).map((c) => [c.item_id, c.thread_id]))
    .toEqual([["cattle", "thrinacia"], ["raft", "ogygia"], ["sail", "ogygia"]]);
  expect(new Set(constituents.map((c) => c.principal_id))).toEqual(new Set([odysseus.id, penelope.id]));
  // The window was fixed at the first arrival: nothing waited until 110 seconds.
  const batches = w.db.query("SELECT principal_id, opened_at, due_at FROM inbox_notice_batches ORDER BY id").all() as Array<{ opened_at: number; due_at: number }>;
  expect(batches.map((b) => b.due_at)).toEqual([start + 60_000, start + 60_000]);

  // A post-dispatch arrival starts a new fixed window of its own.
  w.now = start + 61_000;
  w.decision("bag-of-winds", { stakes: 3, thread: "aeolia" });
  expect(await w.tick(start + 61_000)).toEqual([]);
  expect(await w.tick(start + 120_999)).toEqual([]);
  const second = await w.tick(start + 121_000);
  expect(second.map((s) => s.payload.title)).toEqual(["1 action waiting", "1 action waiting"]);
  // Per-device history keeps both submissions with what was actually sent.
  expect(w.attempts().filter((a) => a.destination === noticeDestination(phone)).map((a) => [a.outcome, a.count])).toEqual([["success", 3], ["success", 1]]);
  // Unresolved work alone never produces a reminder.
  expect(await w.tick(start + DAY)).toEqual([]);
});

test("the real score decides push at 12 and digest below it; promotion after a digest gets its first push", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  const phone = w.device(odysseus, "https://push.example.test/odysseus-phone", "Europe/Athens");
  const morning = athens(0, 9);
  w.now = morning;
  w.decision("medium", { stakes: 2 }); // fresh medium, no deadline: 8
  w.decision("low-48h", { stakes: 1, deadline: morning + 48 * HOUR }); // 4 + 3*2: 10
  w.decision("eleven", { stakes: 2, deadline: morning + 5 * DAY }); // 8 + 3*1: 11
  w.decision("high", { stakes: 3 }); // fresh high, no deadline: 12
  w.decision("omens", { stakes: 3, type: "fyi" });
  expect(await w.tick(morning)).toEqual([]);
  const pushes = await w.tick(morning + 60_000);
  expect(pushes.map((p) => p.payload.title)).toEqual(["1 action waiting"]);
  expect(w.db.query("SELECT item_id FROM inbox_notice_constituents").all()).toEqual([{ item_id: "high" }]);

  const digest = w.notices.digest(ctx(odysseus), morning + 60_000);
  expect(digest.status).toBe("ready");
  const summary = (digest as { latest: ActionDigestSummary }).latest;
  expect(summary.waiting.map((e) => e.itemId).sort()).toEqual(["eleven", "low-48h", "medium"]);
  expect(summary.updates.map((e) => e.itemId)).toEqual(["omens"]);
  const reported = summary.waiting.find((e) => e.itemId === "eleven")!.episodeId;

  // One day of age lifts "eleven" to 12 in the SAME episode: first push.
  expect(await w.tick(morning + DAY)).toEqual([]);
  const promoted = await w.tick(morning + DAY + 60_000);
  expect(promoted.map((p) => [p.endpoint, p.payload.title])).toEqual([[phone, "1 action waiting"]]);
  expect(w.db.query("SELECT episode_id FROM inbox_notice_constituents WHERE item_id = 'eleven'").all()).toEqual([{ episode_id: reported }]);
  expect(w.db.query("SELECT COUNT(*) AS n FROM inbox_notice_episodes WHERE item_id = 'eleven'").get()).toEqual({ n: 1 });
  // After a known success, still-pending work is never re-pushed. Meanwhile
  // the 48-hour decision crossed 12 once under a day remained (4 + 3*3 + 1).
  const dayTwo = await w.tick(morning + 2 * DAY);
  expect(dayTwo.map((p) => p.payload.title)).toEqual(["1 action waiting"]);
  const last = w.db.query(
    `SELECT e.item_id FROM inbox_notice_attempt_components c JOIN inbox_notice_episodes e ON e.id = c.episode_id
     WHERE c.attempt_id = (SELECT MAX(id) FROM inbox_notice_attempts)`
  ).all();
  expect(last).toEqual([{ item_id: "low-48h" }]);
  expect(await w.tick(morning + 2 * DAY + 60_000)).toEqual([]);
});

test("strict local quiet hours: 22:00 is quiet, 08:00 is not, and no deadline bypasses it", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  w.device(odysseus, "https://push.example.test/odysseus-phone", "Europe/Athens");
  // A window due exactly at 22:00 defers; 21:59:30 arrival due 22:00:30 too.
  w.now = athens(0, 21, 59);
  w.decision("at-ten", { stakes: 3 });
  await w.tick(athens(0, 21, 59));
  w.now = athens(0, 21, 59, 30);
  w.decision("half-past", { stakes: 3 });
  await w.tick(athens(0, 21, 59, 30));
  expect(await w.tick(athens(0, 22))).toEqual([]);
  expect(await w.tick(athens(0, 22, 0, 30))).toEqual([]);
  // A qualifying 23:00 arrival with a recorded 06:00 deadline waits as well.
  w.now = athens(0, 23);
  w.decision("before-dawn", { stakes: 3, deadline: athens(1, 6) });
  await w.tick(athens(0, 23));
  expect(await w.tick(athens(0, 23, 1))).toEqual([]);
  expect(await w.tick(athens(1, 6))).toEqual([]);
  expect(await w.tick(athens(1, 7, 59, 59))).toEqual([]);
  const morning = await w.tick(athens(1, 8));
  expect(morning.map((p) => p.payload.title)).toEqual(["3 actions waiting"]);
});

test("overnight work is recounted at 08:00 and a 07:59:45 arrival waits for its own deadline", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  const phone = w.device(odysseus, "https://push.example.test/odysseus-phone", "Europe/Athens");
  for (const [id, hour] of [["sirens", 23], ["scylla", 25], ["charybdis", 27]] as const) {
    w.now = athens(0, hour);
    w.decision(id, { stakes: 3 });
    await w.tick(athens(0, hour));
  }
  w.now = athens(1, 5);
  w.move("scylla", "dismissed");
  w.now = athens(1, 7, 59, 45);
  w.decision("late-omen", { stakes: 3 });
  await w.tick(athens(1, 7, 59, 45));
  const eight = await w.tick(athens(1, 8));
  expect(eight.map((p) => p.payload.title)).toEqual(["2 actions waiting"]);
  const components = w.db.query(
    "SELECT e.item_id FROM inbox_notice_attempt_components c JOIN inbox_notice_episodes e ON e.id = c.episode_id ORDER BY e.item_id"
  ).all();
  expect(components).toEqual([{ item_id: "charybdis" }, { item_id: "sirens" }]);
  expect(await w.tick(athens(1, 8, 0, 44))).toEqual([]);
  const later = await w.tick(athens(1, 8, 0, 45));
  expect(later.map((p) => [p.endpoint, p.payload.title])).toEqual([[phone, "1 action waiting"]]);
});

test("two client zones evaluate independently and follow offset changes", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus"), penelope = w.principal("Penelope");
  const newYork = w.device(odysseus, "https://push.example.test/new-york", "America/New_York");
  const tokyo = w.device(penelope, "https://push.example.test/tokyo", "Asia/Tokyo");
  const at = Date.UTC(2026, 9, 3, 13);
  w.now = at - 60_000;
  w.decision("polyphemus", { stakes: 3 });
  w.now = at - 30 * 60_000;
  w.decision("lotus", { stakes: 1 });
  w.now = at - 60_000;
  await w.tick(at - 60_000);
  const sends = await w.tick(at);
  // 09:00 in New York sends; 22:00 in Tokyo defers.
  expect(sends.map((s) => s.endpoint)).toEqual([newYork]);
  const ny = w.notices.digest(ctx(odysseus), at) as { status: "ready"; latest: ActionDigestSummary };
  expect(ny.latest.slotAt).toBe(at);
  expect(ny.latest.timeZone).toBe("America/New_York");
  expect(ny.latest.waiting.map((e) => e.itemId)).toEqual(["lotus"]);
  // Tokyo's own context and coverage: the New York summary is not its receipt.
  const tk = w.notices.digest(ctx(penelope), at) as { status: "ready"; latest: ActionDigestSummary };
  expect(tk.latest.slotAt).toBe(Date.UTC(2026, 9, 3, 8)); // 17:00 Tokyo
  expect(tk.latest.waiting.map((e) => e.itemId)).toEqual(["lotus"]);
  const morning = await w.tick(Date.UTC(2026, 9, 3, 23)); // 08:00 Tokyo
  expect(morning.map((s) => s.endpoint)).toEqual([tokyo]);

  // New York leaves daylight time on 2026-11-01: 09:00 becomes 14:00Z.
  expect(latestDigestSlot("America/New_York", Date.UTC(2026, 9, 31, 13))).toBe(Date.UTC(2026, 9, 31, 13));
  expect(latestDigestSlot("America/New_York", Date.UTC(2026, 10, 1, 13, 59))).toBe(Date.UTC(2026, 9, 31, 21));
  expect(latestDigestSlot("America/New_York", Date.UTC(2026, 10, 1, 14))).toBe(Date.UTC(2026, 10, 1, 14));
  w.now = Date.UTC(2026, 9, 31, 21);
  w.notices.digest(ctx(odysseus), Date.UTC(2026, 9, 31, 21));
  const count = () => (w.db.query("SELECT COUNT(*) AS n FROM inbox_notice_digests WHERE principal_id = ?").get(odysseus.id) as { n: number }).n;
  const before = count();
  w.notices.digest(ctx(odysseus), Date.UTC(2026, 10, 1, 13, 59));
  expect(count()).toBe(before);
  w.notices.digest(ctx(odysseus), Date.UTC(2026, 10, 1, 14));
  expect(count()).toBe(before + 1);
});

test("missing or invalid zones stay visibly pending until a lifecycle refresh, with no server-time fallback", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  const phone = w.device(odysseus, "https://push.example.test/odysseus-phone");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("principal", odysseus); await next(); });
  app.route("/", createPushRoutes({ sender: w.sender, notices: w.notices }));
  app.route("/", createActivityRoutes({ db: w.db, store: createActivityStore(w.db, { writer: "test" }), actionNotices: w.notices }));
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // 14:00 in Athens is 11:00Z: outside quiet hours in UTC as well, so a
  // silent server-zone fallback would send here.
  w.now = athens(0, 14);
  w.decision("raft", { stakes: 3 });
  w.decision("tribute", { stakes: 1 });
  await w.tick(athens(0, 14));
  expect(await w.tick(athens(0, 14, 1))).toEqual([]);
  const listed = await (await app.request("/push/subscriptions")).json();
  expect(listed.subscriptions[0].timeZone).toBeNull();
  expect((await (await app.request("/activity/digest")).json()).actions).toEqual({ status: "zone_required" });

  // An invalid zone is recorded as unusable, not substituted.
  expect(await (await post("/push/zone", { timeZone: "Aeaea/Circe", endpoint: phone })).json()).toEqual({ ok: true, timeZone: null });
  expect(await w.tick(athens(0, 14, 2))).toEqual([]);
  expect((await post("/push/zone", { timeZone: 7 })).status).toBe(400);

  // Foreground/reconnect refresh: the server stamps its own clock; any client
  // time in the body is ignored, so client skew cannot move a window.
  w.now = athens(0, 14, 3);
  const refreshed = await post("/push/zone", { timeZone: "europe/athens", endpoint: phone, reportedAt: 0 });
  expect(await refreshed.json()).toEqual({ ok: true, timeZone: "Europe/Athens" });
  expect(w.db.query("SELECT time_zone, time_zone_reported_at FROM push_subscriptions").get())
    .toEqual({ time_zone: "Europe/Athens", time_zone_reported_at: athens(0, 14, 3) });
  const sends = await w.tick(athens(0, 14, 3));
  expect(sends.map((s) => s.payload.title)).toEqual(["1 action waiting"]);
  const digest = (await (await app.request("/activity/digest")).json()).actions;
  expect(digest.status).toBe("ready");
  expect(digest.latest.waiting.map((e: { itemId: string }) => e.itemId)).toEqual(["tribute"]);

  // Registration/rebind carries the zone too; omitting it keeps the last one.
  await post("/push/subscribe", { subscription: { endpoint: phone, keys: { p256dh: "p", auth: "a" } } });
  expect(w.db.query("SELECT time_zone FROM push_subscriptions").get()).toEqual({ time_zone: "Europe/Athens" });
  await post("/push/subscribe", { subscription: { endpoint: phone, keys: { p256dh: "p", auth: "a" } }, timeZone: "Asia/Tokyo" });
  expect(w.db.query("SELECT time_zone FROM push_subscriptions").get()).toEqual({ time_zone: "Asia/Tokyo" });
});

test("authenticated rebind and revocation recheck authority at every attempt", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus"), telemachus = w.principal("Telemachus");
  const shared = w.device(odysseus, "https://push.example.test/hall-tablet", "Europe/Athens");
  w.now = athens(0, 10);
  w.decision("suitors", { stakes: 3 });
  await w.tick(athens(0, 10));
  expect((await w.tick(athens(0, 10, 1))).map((s) => s.endpoint)).toEqual([shared]);
  // The same device rebinds to another principal: that device already holds a
  // known success for this episode, so the new owner's aggregate skips it.
  w.device(telemachus, shared, "Europe/Athens");
  expect(await w.tick(athens(0, 10, 2))).toEqual([]);
  expect(await w.tick(athens(0, 10, 3))).toEqual([]);
  w.now = athens(0, 11);
  w.decision("bow", { stakes: 3 });
  await w.tick(athens(0, 11));
  // Revocation written without unbinding still stops delivery.
  revokePrincipal(w.db, telemachus.id, athens(0, 11));
  expect(await w.tick(athens(0, 11, 1))).toEqual([]);
  // The notifier's own attempt check refuses the revoked owner of the device.
  expect(w.notices.beginAttempt({ endpoint: shared, principalId: telemachus.id }, athens(0, 11, 2))).toBeNull();
  expect(w.attempts().filter((a) => a.principal_id === telemachus.id)).toEqual([]);
  // Odysseus no longer owns the device either.
  expect(w.notices.beginAttempt({ endpoint: shared, principalId: odysseus.id }, athens(0, 11, 2))).toBeNull();
});

test("digest B omits reported episodes, keeps snoozed work out and reawakens it as a new episode", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  w.notices.reportZone(ctx(odysseus), "Europe/Athens", undefined, athens(0, 8));
  w.now = athens(0, 8);
  w.decision("old-debt", { stakes: 1 });
  w.decision("rest", { stakes: 1 });
  w.decision("herald", { stakes: 1, type: "fyi" });
  w.move("rest", "snoozed", athens(0, 12));
  const nine = (w.notices.digest(ctx(odysseus), athens(0, 9)) as { latest: ActionDigestSummary }).latest;
  expect(nine.waiting.map((e) => e.itemId)).toEqual(["old-debt"]);
  expect(nine.updates.map((e) => e.itemId)).toEqual(["herald"]);
  w.now = athens(0, 10);
  w.decision("new-arrival", { stakes: 1 });
  // Explicit snooze reactivation, as the lifecycle sweep performs it.
  w.now = athens(0, 12);
  sweepInboxLifecycle(w.db, athens(0, 12));
  expect(w.store.getItem("rest")!.status).toBe("pending");
  const five = (w.notices.digest(ctx(odysseus), athens(0, 17)) as { latest: ActionDigestSummary }).latest;
  expect(five.waiting.map((e) => e.itemId).sort()).toEqual(["new-arrival", "rest"]);
  expect(five.updates).toEqual([]);
  // Unchanged, still pending, still in Actions: omitted at 17:00.
  expect(w.store.getItem("old-debt")!.status).toBe("pending");
  expect(w.db.query("SELECT COUNT(*) AS n FROM inbox_notice_episodes WHERE item_id = 'rest'").get()).toEqual({ n: 2 });
});

test("missed slots catch up once with older unreported work; failures and races never consume coverage", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  w.notices.reportZone(ctx(odysseus), "Europe/Athens", undefined, athens(0, 8));
  w.now = athens(-30, 8);
  w.decision("ancient", { stakes: 1 }); // a month old, never reported
  const generations = () => (w.db.query("SELECT COUNT(*) AS n FROM inbox_notice_digests").get() as { n: number }).n;

  // A generation that fails stores nothing and covers nothing.
  w.db.exec("CREATE TRIGGER refuse_coverage BEFORE INSERT ON inbox_notice_coverage BEGIN SELECT RAISE(ABORT, 'fixture coverage refusal'); END");
  expect(() => w.notices.digest(ctx(odysseus), athens(3, 10))).toThrow("fixture coverage refusal");
  expect(generations()).toBe(0);
  w.db.exec("DROP TRIGGER refuse_coverage");

  // Two racing generators on separate connections: one stored summary.
  const second = createUiDb(w.path);
  cleanup.push(() => second.close());
  const rival = createActionNotifier(second, { now: () => athens(3, 10) });
  const a = w.notices.digest(ctx(odysseus), athens(3, 10)) as { latest: ActionDigestSummary };
  const b = rival.digest(ctx(odysseus), athens(3, 10)) as { latest: ActionDigestSummary };
  expect(generations()).toBe(1);
  expect(a.latest).toEqual(b.latest);
  expect(a.latest.slotAt).toBe(athens(3, 9));
  expect(a.latest.waiting.map((e) => e.itemId)).toEqual(["ancient"]);
  expect(w.db.query("SELECT COUNT(*) AS n FROM inbox_notice_coverage").get()).toEqual({ n: 1 });
  // The scheduled pass agrees: nothing more is due until 17:00.
  expect(w.notices.generateDue(athens(3, 16, 59))).toBe(0);
  expect(w.notices.generateDue(athens(3, 17))).toBe(1);
});

test("partial-device success is kept; retries carry only remaining eligible unsent decisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-notify-restart-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const w = world({ path: join(dir, "ui.sqlite") });
  const odysseus = w.principal("Odysseus");
  const ship = w.device(odysseus, "https://push.example.test/ship", "Europe/Athens");
  const shore = w.device(odysseus, "https://push.example.test/shore", "Europe/Athens");
  w.modes.set(shore, "fail");
  w.now = athens(0, 10);
  w.decision("helios", { stakes: 3 });
  w.decision("calypso", { stakes: 3 });
  await w.tick(athens(0, 10));
  const first = await w.tick(athens(0, 10, 1));
  expect(first.map((s) => [s.endpoint, s.payload.title])).toEqual([[ship, "2 actions waiting"]]);
  w.now = athens(0, 10, 2);
  w.move("helios", "dismissed");
  w.modes.set(shore, "ok");
  // Bounded backoff: nothing before five minutes.
  expect(await w.tick(athens(0, 10, 5))).toEqual([]);

  // Restart: a fresh notifier and sender on the same database.
  const reopened = world({ path: w.path });
  reopened.modes.set(shore, "ok");
  const retry = await reopened.tick(athens(0, 10, 7));
  expect(retry.map((s) => [s.endpoint, s.payload.title])).toEqual([[shore, "1 action waiting"]]);
  // Earlier history is frozen with what each device was actually sent.
  expect(reopened.attempts().map((a) => [a.destination, a.outcome, a.count])).toEqual([
    [noticeDestination(ship), "success", 2],
    [noticeDestination(shore), "failed", 2],
    [noticeDestination(shore), "success", 1],
  ]);
  expect(await reopened.tick(athens(0, 11))).toEqual([]);
  // Restart and retry invented no episode.
  expect(reopened.db.query("SELECT COUNT(*) AS n FROM inbox_notice_episodes").get()).toEqual({ n: 2 });
  expect(() => reopened.db.query("UPDATE inbox_notice_attempts SET count = 9 WHERE id = 1").run()).toThrow("Immutable notice attempt");
});

test("ambiguous outcomes stay distinct from success, retry within the bound and quiet hours", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  const mast = w.device(odysseus, "https://push.example.test/mast", "Europe/Athens");
  w.modes.set(mast, "timeout");
  w.now = athens(0, 21, 50);
  w.decision("sirens", { stakes: 3 });
  await w.tick(athens(0, 21, 50));
  await w.tick(athens(0, 21, 51));
  expect(w.attempts().map((a) => a.outcome)).toEqual(["ambiguous"]);
  // The retry would fall due at 21:56; the next tick after backoff is quiet.
  expect(await w.tick(athens(0, 22, 1))).toEqual([]);
  expect(w.attempts()).toHaveLength(1);
  await w.tick(athens(1, 8));
  await w.tick(athens(1, 8, 6));
  expect(w.attempts().map((a) => a.outcome)).toEqual(["ambiguous", "ambiguous", "ambiguous"]);
  // The attempt budget is spent: no fourth attempt, no claimed delivery.
  w.modes.set(mast, "ok");
  expect(await w.tick(athens(1, 9))).toEqual([]);
  expect(w.attempts().some((a) => a.outcome === "success")).toBe(false);
});

test("a gone destination is pruned and no device credential reaches history", async () => {
  const w = world();
  const odysseus = w.principal("Odysseus");
  const wreck = w.device(odysseus, "https://push.example.test/wreck", "Europe/Athens");
  w.modes.set(wreck, "gone");
  w.now = athens(0, 10);
  w.decision("raft", { stakes: 3 });
  await w.tick(athens(0, 10));
  await w.tick(athens(0, 10, 1));
  expect(w.db.query("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
  expect(w.attempts().map((a) => a.outcome)).toEqual(["gone"]);
  const state = JSON.stringify(w.store.exportState());
  expect(state).not.toContain(wreck);
  expect(state).toContain(noticeDestination(wreck));
});

test("browsers sharing one principal keep their own zone, coverage and dismissal", async () => {
  const w = world();
  const household = w.principal("Ithaca household"); // one ambient/proxy identity, two browsers
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("principal", household); await next(); });
  app.route("/", createPushRoutes({ sender: w.sender, notices: w.notices }));
  app.route("/", createActivityRoutes({ db: w.db, store: createActivityStore(w.db, { writer: "test" }), actionNotices: w.notices }));
  const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const at = Date.UTC(2026, 9, 3, 13);
  w.now = at - HOUR;
  w.decision("loom", { stakes: 1 });
  w.now = at;
  expect((await post("/push/zone", { timeZone: "America/New_York", clientId: "hall-tablet" })).status).toBe(200);
  expect((await post("/push/zone", { timeZone: "Asia/Tokyo", clientId: "harbor-phone" })).status).toBe(200);
  expect((await post("/push/zone", { timeZone: "Asia/Tokyo", clientId: "../escape" })).status).toBe(400);
  const read = async (client: string) => (await (await app.request(`/activity/digest?client=${client}`)).json()).actions;
  const hall = await read("hall-tablet"), harbor = await read("harbor-phone");
  expect([hall.timeZone, hall.latest.timeZone]).toEqual(["America/New_York", "America/New_York"]);
  expect([harbor.timeZone, harbor.latest.timeZone]).toEqual(["Asia/Tokyo", "Asia/Tokyo"]);
  // Each browser's first summary reports the decision; neither consumed the other's.
  expect(hall.latest.waiting.map((e: { itemId: string }) => e.itemId)).toEqual(["loom"]);
  expect(harbor.latest.waiting.map((e: { itemId: string }) => e.itemId)).toEqual(["loom"]);
  // Dismissing on one browser leaves the other's summary visible.
  w.now = at + 60_000;
  await post("/activity/digest/dismiss?client=hall-tablet");
  expect((await read("hall-tablet")).dismissedAt).toBe(at + 60_000);
  expect((await read("harbor-phone")).dismissedAt).toBeNull();
});
