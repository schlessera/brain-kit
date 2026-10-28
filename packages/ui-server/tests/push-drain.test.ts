import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityNotifier } from "../src/activity/notify.js";
import { createPushSender } from "../src/activity/push-sender.js";
import type { PushWrites } from "../src/activity/notify-writes.js";
import { rejection } from "./helpers/expect-rejection.js";
import { watchRetainedErrors } from "./helpers/retained-errors.js";

function fixture(touch: PushWrites["touch"]) {
  const db = createUiDb(":memory:"), store = createActivityStore(db, { writer: "test" });
  const notifier = createActivityNotifier({ db, store, isWatched: () => false });
  const sender = createPushSender(db, { send: async () => {}, writes: { touch, drop: async () => {} } });
  const owner = createPrincipal(db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
  for (const name of ["ithaca", "troy"]) sender.subscribe({ endpoint: `https://push.example.test/${name}`, keys: { p256dh: "k", auth: "a" } }, owner.id);
  store.startSpan({ runId: "voyage", spanId: "voyage:root", name: "invoke_agent", kind: "turn", origin: "session" });
  store.endSpan("voyage:root", { outcome: "error" }); notifier.tick();
  return { db, notifier, sender };
}

test("failed bookkeeping still joins a sibling write before delivery and close settle", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const failure = Error("Odysseus bookkeeping refused");
  const f = fixture(async endpoint => {
    if (endpoint.endsWith("ithaca")) throw failure;
    entered(); await held;
  });
  let settled = false, closed = false;
  const delivery = f.sender.deliverPending(f.notifier).then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await started;
    const closing = f.sender.close().then(() => { closed = true; }, error => { closed = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled, "FAILED_BOOKKEEPING_JOINS_SIBLING_WRITE").toBe(false);
    expect(closed, "DRAIN_JOINS_SIBLING_OF_FAILED_WRITE").toBe(false);
    release();
    expect(await delivery).toBe(failure);
    expect(await closing).toBe(failure);
    expect(await rejection(f.sender.close())).toBe(failure);
  } finally { release(); await delivery; await f.sender.close().catch(() => {}); f.db.close(); }
});

test("multiple failed outcome writes retain their original errors in delivery and repeated close", async () => {
  const failures = [Error("Odysseus first write refused"), Error("Odysseus second write refused")];
  const f = fixture(async endpoint => { throw failures[endpoint.endsWith("ithaca") ? 0 : 1]; });
  try {
    const error = await rejection(f.sender.deliverPending(f.notifier));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
    expect(await rejection(f.sender.close())).toBe(error);
    expect(await rejection(f.sender.close())).toBe(error);
  } finally { await f.sender.close().catch(() => {}); f.db.close(); }
});

test("delivery retry failures retain bounded diagnostics through recovery and late close", async () => {
  const errors = Array.from({ length: 60 }, (_, i) => Error(`Odysseus write refused ${i}`));
  const retained = watchRetainedErrors(errors);
  let calls = 0, recovered = false;
  const f = fixture(async () => { if (!recovered) throw errors[calls++]; });
  f.db.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%troy'").run();
  try {
    for (const error of errors) expect(await rejection(f.sender.deliverPending(f.notifier))).toBe(error);
    recovered = true;
    expect(await f.sender.deliverPending(f.notifier)).toBe(1);
    expect(retained.peak(), "DELIVERY_RETRY_ERROR_RETENTION_BOUNDED_WHILE_RUNNING").toBeLessThanOrEqual(4);
    const closing = f.sender.close();
    expect(f.sender.close()).toBe(closing);
    const failure = await rejection(closing) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors, "DELIVERY_RETRY_DIAGNOSTICS_BOUNDED").toEqual(errors.slice(0, 4));
    expect(failure.cause).toBe(errors[0]);
    expect(failure.message).toContain("60 failed operations");
    expect(failure.message).toContain("representatives");
    expect(await rejection(f.sender.close())).toBe(failure);
  } finally { retained.restore(); await f.sender.close().catch(() => {}); f.db.close(); }
});

test("same-kind independent calls preserve their own inputs, counts and failures through close", async () => {
  const failure = Error("Odysseus second outcome refused");
  const f = fixture(async () => {});
  f.db.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%troy'").run();
  const intent = f.notifier.pending()[0]!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const marked: number[] = [];
  const first = { ...f.notifier, pending: () => [intent, { ...intent, id: intent.id + 1 }], markDelivered: async (id: number) => { marked.push(id); } };
  const second = { ...f.notifier, pending: () => [{ ...intent, id: intent.id + 2 }], markDelivered: async () => { await gate; throw failure; } };
  const one = f.sender.deliverPending(first);
  const two = f.sender.deliverPending(second).then(value => ({ value }), error => ({ error }));
  try {
    expect(await one, "INDEPENDENT_DELIVERY_RETAINS_OWN_COUNT").toBe(2);
    expect(marked).toEqual([intent.id, intent.id + 1]);
    const closing = f.sender.close();
    expect(f.sender.close()).toBe(closing);
    expect(await f.sender.deliverPending(first)).toBe(0);
    release();
    expect(await two, "INDEPENDENT_DELIVERY_RETAINS_OWN_FAILURE").toEqual({ error: failure });
    expect(await rejection(closing)).toBe(failure);
    expect(await rejection(f.sender.close())).toBe(failure);
  } finally { release(); await two; await f.sender.close().catch(() => {}); f.db.close(); }
});

test("settling a delivery cannot remove a reentrant same-kind delivery from the drain", async () => {
  const f = fixture(async () => {});
  f.db.query("DELETE FROM push_subscriptions WHERE endpoint LIKE '%troy'").run();
  const intent = f.notifier.pending()[0]!;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const second = { ...f.notifier, markDelivered: async () => { entered(); await held; } };
  let reentrant: Promise<number> | undefined;
  const first = { ...f.notifier, markDelivered: async () => { reentrant = f.sender.deliverPending(second); } };
  try {
    expect(await f.sender.deliverPending(first)).toBe(1);
    for (let i = 0; i < 20 && !reentrant; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(reentrant, "REENTRANT_DELIVERY_ADMITTED").toBeDefined();
    // The first promise has settled; its removal must leave the new owner intact.
    let settled = false;
    const closing = f.sender.close().then(() => { settled = true; });
    await Promise.race([started, new Promise(resolve => setTimeout(resolve, 20))]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled, "SETTLED_CALL_CANNOT_DELETE_REENTRANT_OWNER").toBe(false);
    release();
    expect(await reentrant).toBe(1);
    await closing;
    expect(intent).toBeDefined();
  } finally { release(); await reentrant; await f.sender.close().catch(() => {}); f.db.close(); }
});
