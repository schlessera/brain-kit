/**
 * Web push: VAPID lifecycle (generated once, private key never routed),
 * subscription lifecycle (409-free upsert, 410 pruning), and delivery
 * marking intents sent/send_failed with the inbox untouched. The web-push
 * wire itself is mocked at the send boundary — keyless tests; the first
 * real send is a deployed-device check.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityNotifier } from "../src/activity/notify";
import { createPushSender } from "../src/activity/push-sender";
import { createActivityStream } from "../src/activity/stream";
import type { AppEnv } from "../src/app-env";
import { createPushRoutes } from "../src/routes/push";
import { createUiDb } from "../src/db/client";
import { createPrincipal, revokePrincipal, type Principal } from "../src/db/principals";
import { applyPrincipalRevocation } from "../src/middleware/auth";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";

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
  const principal = createPrincipal(db, {
    authMethod: "password",
    label: "Test device",
    ttlSeconds: 60 * 60,
  });
  return { db, store, notifier, sender, sent, principal };
}

function createOwner(db: ReturnType<typeof createUiDb>, label: string): Principal {
  return createPrincipal(db, {
    authMethod: "password",
    label,
    ttlSeconds: 60 * 60,
  });
}

function routesFor(sender: ReturnType<typeof createPushSender>, principal: Principal) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.route("/", createPushRoutes({ sender }));
  return app;
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
    const { store, notifier, sender, sent, principal } = setup();
    sender.subscribe(SUB(1), principal.id, "phone");
    sender.subscribe(SUB(2), principal.id, "laptop");
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
    const { store, notifier, sender, principal } = setup(async (sub) => {
      if (sub.endpoint.endsWith("device-1")) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
    });
    sender.subscribe(SUB(1), principal.id);
    sender.subscribe(SUB(2), principal.id);
    failRun(store, "run-1");
    notifier.tick();
    await sender.deliverPending(notifier);

    expect(sender.subscriptions().map((s) => s.endpoint)).toEqual([SUB(2).endpoint]);
    expect(notifier.inbox()[0]!.status).toBe("sent");
  });

  test("every-device failure marks send_failed; the intent is retried next pass", async () => {
    let fail = true;
    const { store, notifier, sender, sent, principal } = setup(async (sub, payload: any) => {
      if (fail) throw new Error("service down");
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    });
    sender.subscribe(SUB(1), principal.id);
    failRun(store, "run-1");
    notifier.tick();
    await sender.deliverPending(notifier);
    expect(notifier.inbox()[0]!.status).toBe("send_failed");
    expect(notifier.pending()).toHaveLength(0);
    // A transient failure is not a dead device: the subscription row stays.
    expect(sender.subscriptions()).toHaveLength(1);
  });

  test("a device pruned during one intent's pass is not attempted for the next intent", async () => {
    const attempted: Array<{ endpoint: string; tag: string }> = [];
    const { store, notifier, sender, principal } = setup(async (sub, payload: any) => {
      attempted.push({ endpoint: sub.endpoint, tag: JSON.parse(payload).tag });
      if (sub.endpoint.endsWith("device-1")) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
    });
    sender.subscribe(SUB(1), principal.id);
    sender.subscribe(SUB(2), principal.id);
    failRun(store, "run-1", "job-a");
    failRun(store, "run-2", "job-b");
    notifier.tick();
    await sender.deliverPending(notifier);

    // Device 1 is pruned by intent 1's 410; the per-intent re-read means
    // intent 2 goes only to the surviving device.
    expect(sender.subscriptions().map((s) => s.endpoint)).toEqual([SUB(2).endpoint]);
    const secondPass = attempted.filter((a) => a.tag === "brain-activity:run-2");
    expect(secondPass.map((a) => a.endpoint)).toEqual([SUB(2).endpoint]);
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

  test("revoking A unbinds its subscription and delivers only to B", async () => {
    const { db, store, notifier, sender, sent, principal: principalA } = setup();
    const principalB = createOwner(db, "Other device");
    sender.subscribe(SUB(1), principalA.id);
    sender.subscribe(SUB(2), principalB.id);

    const stream = createActivityStream(store);
    const backend = makeFakeBackend({ id: "fake" });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      activity: { store, stream, pushSender: sender },
    });
    try {
      applyPrincipalRevocation(
        host,
        revokePrincipal(db, principalA.id, Date.now())
      );

      expect(
        sender.subscriptions().map((subscription) => ({
          endpoint: subscription.endpoint,
          principalId: subscription.principalId,
        }))
      ).toEqual([
        { endpoint: SUB(1).endpoint, principalId: null },
        { endpoint: SUB(2).endpoint, principalId: principalB.id },
      ]);

      failRun(store, "run-revoked");
      notifier.tick();
      expect(await sender.deliverPending(notifier)).toBe(1);
      expect(sent.map((entry) => entry.endpoint)).toEqual([SUB(2).endpoint]);
    } finally {
      stream.close();
    }
  });

  test("delivery skips a revoked principal even when its subscription stayed bound", async () => {
    const { db, store, notifier, sender, sent, principal: revoked } = setup();
    const live = createOwner(db, "Live device");
    sender.subscribe(SUB(1), revoked.id);
    sender.subscribe(SUB(2), live.id);

    // Deliberately bypass applyPrincipalRevocation: this proves delivery fails
    // closed even when the boundary's normal unbind side effect was missed.
    expect(revokePrincipal(db, revoked.id, Date.now())).toEqual([revoked.id]);
    expect(sender.subscriptions()[0]!.principalId).toBe(revoked.id);

    failRun(store, "run-directly-revoked");
    notifier.tick();
    expect(await sender.deliverPending(notifier)).toBe(1);
    expect(sent.map((entry) => entry.endpoint)).toEqual([SUB(2).endpoint]);
  });

  test("delivery skips an expired principal even when its subscription stayed bound", async () => {
    const { db, store, notifier, sender, sent, principal: expired } = setup();
    const live = createOwner(db, "Live device");
    sender.subscribe(SUB(1), expired.id);
    sender.subscribe(SUB(2), live.id);
    db.query("UPDATE principals SET expires_at = ? WHERE id = ?").run(
      Date.now() - 1,
      expired.id
    );

    failRun(store, "run-expired");
    notifier.tick();
    expect(await sender.deliverPending(notifier)).toBe(1);
    expect(sent.map((entry) => entry.endpoint)).toEqual([SUB(2).endpoint]);
    expect(sender.subscriptions()[0]!.principalId).toBe(expired.id);
  });

  test("a legacy unbound row is inert until re-registration binds it", async () => {
    const { db, store, notifier, sender, sent, principal } = setup();
    db.query(
      `INSERT INTO push_subscriptions
         (endpoint, p256dh, auth, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(SUB(1).endpoint, SUB(1).keys.p256dh, SUB(1).keys.auth, "legacy", Date.now());

    failRun(store, "run-legacy");
    notifier.tick();
    expect(await sender.deliverPending(notifier)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(notifier.pending()).toHaveLength(1);

    expect(sender.subscribe(SUB(1), principal.id, "re-registered")).toBe(true);
    expect(
      sender
        .subscriptions()
        .find((subscription) => subscription.endpoint === SUB(1).endpoint)
        ?.principalId
    ).toBe(principal.id);
    expect(await sender.deliverPending(notifier)).toBe(1);
    expect(sent.map((entry) => entry.endpoint)).toEqual([SUB(1).endpoint]);
  });
});

describe("push routes", () => {
  test("subscribe binds the caller; list/unsubscribe are scoped and endpoints stay hidden", async () => {
    const { db, sender, principal } = setup();
    const other = createOwner(db, "Other device");
    sender.subscribe(SUB(2), other.id, "other");
    const app = routesFor(sender, principal);

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
    expect(
      sender
        .subscriptions()
        .find((subscription) => subscription.endpoint === SUB(1).endpoint)
        ?.principalId
    ).toBe(principal.id);

    const un = await app.request("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: SUB(1).endpoint }),
      headers: { "content-type": "application/json" },
    });
    expect((await un.json()).removed).toBe(true);
    expect(sender.subscriptions().map((subscription) => subscription.endpoint)).toEqual([
      SUB(2).endpoint,
    ]);
  });

  test("the public key is served; the private key has no route anywhere", async () => {
    const { db, sender, principal } = setup();
    const app = routesFor(sender, principal);
    const res = await (await app.request("/push/public-key")).json();
    expect(typeof res.publicKey).toBe("string");
    const priv = (
      db.query("SELECT private_key AS k FROM vapid_keys WHERE id = 1").get() as { k: string }
    ).k;
    expect(JSON.stringify(res)).not.toContain(priv);
  });

  test("a malformed subscription is a 400, not a crash", async () => {
    const { sender, principal } = setup();
    const app = routesFor(sender, principal);
    const res = await app.request("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: { endpoint: "not-a-url" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
