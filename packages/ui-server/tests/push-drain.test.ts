import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityNotifier } from "../src/activity/notify.js";
import { createPushSender } from "../src/activity/push-sender.js";
import type { PushWrites } from "../src/activity/notify-writes.js";
import { rejection } from "./helpers/expect-rejection.js";

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
