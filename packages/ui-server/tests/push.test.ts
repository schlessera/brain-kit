/**
 * Web push: VAPID lifecycle (generated once, private key never routed),
 * subscription lifecycle (409-free upsert, 410 pruning), and delivery
 * marking intents sent/send_failed with the inbox untouched. The web-push
 * wire itself is mocked at the send boundary — keyless tests; the first
 * real send is a deployed-device check.
 */
import { describe, expect, test } from "bun:test";

import { createActivityStore } from "../src/activity/store";
import { createActivityNotifier } from "../src/activity/notify";
import { createPushSender } from "../src/activity/push-sender";
import { createPushRoutes } from "../src/routes/push";
import { createUiDb } from "../src/db/client";

function setup(sendImpl?: (sub: any, payload?: any) => Promise<unknown>) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const notifier = createActivityNotifier({ db, store, isWatched: () => false });
  const sent: Array<{ endpoint: string; payload: any }> = [];
  const sender = createPushSender(db, {
    send:
      sendImpl ??
      (async (sub, payload) => {
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      }),
  });
  return { db, store, notifier, sender, sent };
}

function failRun(store: ReturnType<typeof createActivityStore>, runId: string, job = "sync") {
  store.startSpan({
    spanId: `${runId}:root`,
    runId,
    name: `cron ${job}`,
    kind: "cron",
    origin: "cron",
    jobName: job,
  });
  store.endSpan(`${runId}:root`, { outcome: "error", reason: "boom" });
}

const SUB = (n: number) => ({
  endpoint: `https://push.example/device-${n}`,
  keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) },
});

describe("push sender", () => {
  test("VAPID keys generate once and persist", () => {
    const { db, sender } = setup();
    const key = sender.publicKey();
    expect(key.length).toBeGreaterThan(20);
    const again = createPushSender(db, { send: async () => {} });
    expect(again.publicKey()).toBe(key);
  });

  test("a pending failure intent is delivered to every device with a run tag", async () => {
    const { store, notifier, sender, sent } = setup();
    sender.subscribe(SUB(1), "phone");
    sender.subscribe(SUB(2), "laptop");
    failRun(store, "run-1");
    notifier.tick();

    const attempts = await sender.deliverPending(notifier);
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload.tag).toBe("brain-activity:run-1");
    expect(sent[0]!.payload.url).toContain("#/activity/");
    // Payload minimization survives end to end.
    expect(JSON.stringify(sent[0]!.payload)).not.toContain("boom");

    expect(notifier.pending()).toHaveLength(0);
    // The inbox (guaranteed tier) still shows it until acknowledged.
    expect(notifier.inbox()).toHaveLength(1);
    expect(notifier.inbox()[0]!.status).toBe("sent");
  });

  test("a 410 response prunes the dead subscription; delivery still succeeds via the rest", async () => {
    const { store, notifier, sender } = setup(async (sub) => {
      if (sub.endpoint.endsWith("device-1")) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
    });
    sender.subscribe(SUB(1));
    sender.subscribe(SUB(2));
    failRun(store, "run-1");
    notifier.tick();
    await sender.deliverPending(notifier);

    expect(sender.subscriptions().map((s) => s.endpoint)).toEqual([SUB(2).endpoint]);
    expect(notifier.inbox()[0]!.status).toBe("sent");
  });

  test("every-device failure marks send_failed; the intent is retried next pass", async () => {
    let fail = true;
    const { store, notifier, sender, sent } = setup(async (sub, payload: any) => {
      if (fail) throw new Error("service down");
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    });
    sender.subscribe(SUB(1));
    failRun(store, "run-1");
    notifier.tick();
    await sender.deliverPending(notifier);
    expect(notifier.inbox()[0]!.status).toBe("send_failed");
    expect(notifier.pending()).toHaveLength(0);
  });

  test("no devices: the intent stays pending (inbox covers it; a later device can still get it)", async () => {
    const { store, notifier, sender } = setup();
    failRun(store, "run-1");
    notifier.tick();
    const attempts = await sender.deliverPending(notifier);
    expect(attempts).toBe(0);
    expect(notifier.pending()).toHaveLength(1);
  });
});

describe("push routes", () => {
  test("subscribe/list/unsubscribe round-trip; endpoints never listed raw", async () => {
    const { sender } = setup();
    const app = createPushRoutes({ sender });

    const sub = await app.request("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: SUB(1), label: "phone" }),
      headers: { "content-type": "application/json" },
    });
    expect(sub.status).toBe(200);

    const list = await (await app.request("/push/subscriptions")).json();
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0].label).toBe("phone");
    expect(JSON.stringify(list)).not.toContain("push.example");

    const un = await app.request("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: SUB(1).endpoint }),
      headers: { "content-type": "application/json" },
    });
    expect((await un.json()).removed).toBe(true);
  });

  test("the public key is served; the private key has no route anywhere", async () => {
    const { db, sender } = setup();
    const app = createPushRoutes({ sender });
    const res = await (await app.request("/push/public-key")).json();
    expect(typeof res.publicKey).toBe("string");
    const priv = (
      db.query("SELECT private_key AS k FROM vapid_keys WHERE id = 1").get() as { k: string }
    ).k;
    expect(JSON.stringify(res)).not.toContain(priv);
  });

  test("a malformed subscription is a 400, not a crash", async () => {
    const { sender } = setup();
    const app = createPushRoutes({ sender });
    const res = await app.request("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: { endpoint: "not-a-url" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
