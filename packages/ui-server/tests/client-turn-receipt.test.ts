import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import type { WsHost } from "../src/ws/host.js";
import type { WSContext } from "../src/ws/clients.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";

const pairs = { sendToFirstHostFrameMs: 4, sendToFirstContentFrameMs: 204, lastContentFrameToIdleMs: 8 };
test("an owner receipt joins completed lifecycle reads without changing the host record", async () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db);
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1300, "odysseus");
    lifecycle.finish("success");
    const raw = () => db.query("SELECT record FROM activity_turn_lifecycles").get();
    const before = raw();
    const host = { activity: { store, stream: { pump() {} } }, reportDroppedFrame() {} } as unknown as WsHost;
    await handleClientMessage(host, {} as WSContext, { type: "client_turn_receipt", turnId: "turn-ithaca", timing: pairs },
      { principal: testPrincipal("odysseus"), authorization: testAuthorization("odysseus") });
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(pairs);
    expect(raw()).toEqual(before);
    expect(store.lifecycles()[0]?.clientTiming).toEqual(pairs);
    expect(store.lifecycleChangesSince(0).at(-1)?.lifecycle.clientTiming).toEqual(pairs);
  } finally { db.close(); }
});

test("wrong owner, duplicates and unknown or unfinished turns are refused without affecting another turn", async () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db);
    const finish = (id: string, owner: string) => {
      const lifecycle = createTurnLifecycle(store, id, "ithaca", 1000, () => {}, () => 1300, owner);
      lifecycle.finish("success");
    };
    finish("turn-ithaca", "odysseus"); finish("turn-troy", "eurylochus");
    createTurnLifecycle(store, "turn-open", "ithaca", 1000, () => {}, () => 1300, "odysseus");
    const replies: unknown[] = [];
    const host = { activity: { store, stream: { pump() {} } }, reportDroppedFrame(reason: string) { replies.push(reason); } } as unknown as WsHost;
    const report = (id: string, principalId: string, timing = pairs) => handleClientMessage(host, {} as WSContext,
      { type: "client_turn_receipt", turnId: id, timing }, { principal: testPrincipal(principalId), authorization: testAuthorization(principalId) });
    await report("turn-ithaca", "eurylochus");
    await report("turn-open", "odysseus");
    await report("turn-missing", "odysseus");
    expect(replies).toHaveLength(3);
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toBeUndefined();
    await report("turn-ithaca", "odysseus");
    await report("turn-ithaca", "odysseus", { ...pairs, sendToFirstHostFrameMs: 999 });
    expect(replies).toHaveLength(4);
    expect(replies).toEqual(Array.from({ length: 4 }, () => "client_turn_receipt_refused"));
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(pairs);
    await report("turn-troy", "eurylochus");
    expect(store.lifecycle("turn-troy")?.clientTiming).toEqual(pairs);
    db.query("DELETE FROM activity_turn_lifecycles WHERE turn_id = ?").run("turn-ithaca");
    expect(db.query("SELECT * FROM activity_turn_clients WHERE turn_id = ?").get("turn-ithaca")).toBeNull();
    expect(store.lifecycle("turn-troy")?.clientTiming).toEqual(pairs);
  } finally { db.close(); }
});

test("wire and storage reject host fields, non-finite and negative timing values", async () => {
  const { clientMessageSchema } = await import("@schlessera/brain-ui-sdk/schemas");
  const valid = { type: "client_turn_receipt", turnId: "turn-ithaca", timing: pairs };
  expect(clientMessageSchema.safeParse(valid).success).toBe(true);
  for (const frame of [
    { ...valid, outcome: "success" },
    { ...valid, timing: { ...pairs, acceptedAt: 0 } },
    { ...valid, timing: { ...pairs, sendToFirstHostFrameMs: -1 } },
    { ...valid, timing: { ...pairs, sendToFirstContentFrameMs: Infinity } },
  ]) expect(clientMessageSchema.safeParse(frame).success).toBe(false);
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db);
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1300, "odysseus");
    lifecycle.finish("success");
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", { ...pairs, acceptedAt: 0 } as typeof pairs)).toBe(false);
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toBeUndefined();
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", pairs)).toBe(true);
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(pairs);
  } finally { db.close(); }
});

test("offloop completion settles ownership before the once-only receipt commits", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openSqliteWriter } = await import("../src/db/write-worker.js");
  const { createOffloopActivityStore } = await import("../src/activity/store-writes.js");
  const root = mkdtempSync(join(tmpdir(), "client-turn-ithaca-"));
  const db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db);
  try {
    const store = createOffloopActivityStore(db, writer);
    const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1300, "odysseus");
    lifecycle.finish("success");
    await lifecycle.settled();
    expect(await store.writeClientReceipt!("turn-ithaca", "odysseus", pairs)).toBe(true);
    expect(await store.writeClientReceipt!("turn-ithaca", "odysseus", pairs)).toBe(false);
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(pairs);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the previous SDK schema parses receipt-enriched lifecycle snapshots and deltas", async () => {
  const { previousActivityFrameSchema } = await import("./fixtures/previous-client-turn-schema.js");
  const { createActivityStream } = await import("../src/activity/stream.js");
  const db = createUiDb(":memory:");
  const store = createActivityStore(db);
  let now = 1000;
  const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now, "odysseus");
  const stop = lifecycle.timer("governed")("inference_origin");
  now = 1100; stop(); lifecycle.finish("success");
  const stream = createActivityStream(store);
  try {
    const frames: Array<{ type: string; lifecycle?: unknown; lifecycles?: unknown[] }> = [];
    const ws: WSContext = { send: text => frames.push(JSON.parse(text)) };
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "session", sessionId: "ithaca" }, "odysseus");
    expect(frames).toHaveLength(1);
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", pairs)).toBe(true);
    stream.pump();
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "session", sessionId: "ithaca" }, "odysseus");
    const delta = frames.find(frame => frame.type === "activity_delta");
    const snapshot = frames.at(-1)!;
    expect(delta).toMatchObject({ lifecycle: { clientTiming: pairs } });
    expect(snapshot).toMatchObject({ type: "activity_snapshot", lifecycles: [{ clientTiming: pairs }] });
    expect(previousActivityFrameSchema.safeParse(delta)).toMatchObject({ success: true, data: delta });
    expect(previousActivityFrameSchema.safeParse(snapshot)).toMatchObject({ success: true, data: snapshot });
    // Negative control: the pinned old validator really retains its closed
    // phase enum. A new enum value would make this compatibility test red.
    const record = store.lifecycle("turn-ithaca")!;
    expect(record.subPhases).toHaveLength(1);
    expect(previousActivityFrameSchema.safeParse({ ...snapshot, lifecycles: [{ ...record,
      subPhases: [{ ...record.subPhases![0], phase: "terminal" }],
    }] }).success).toBe(false);
  } finally { stream.close(); db.close(); }
});
