import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchdogMs } from "../../../scripts/test-deadlines.ts";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { prepareClientTurnReceipt } from "../src/ws/client-turn-receipts.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { publishTurnStatus, teardownTurn } from "../src/ws/session-run/teardown.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import type { WsHost } from "../src/ws/host.js";
import type { TurnRun } from "../src/ws/session-run/types.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";
import * as probe from "./fixtures/client-turn-writer-probe.js";

test("idle eligibility never reads lifecycle storage", () => {
  let reads = 0;
  const frames: unknown[] = [];
  const host = { activity: { store: { lifecycle() { reads++; throw new Error("Lifecycle I/O on idle"); } } },
    sendToClients: (frame: unknown) => frames.push(frame), log: { emit() {} } } as unknown as WsHost;
  publishTurnStatus({ host, turn: { turnId: "turn-ithaca", sessionId: "ithaca" } as never, clientReceiptEligible: true }, { cancelledBeforeStart: false });
  expect(reads).toBe(0);
  expect(frames[0]).toMatchObject({ type: "status", status: "idle", hostTurnComplete: true });
});

test("file-backed writer cannot hold idle and a receipt waits for its late terminal commit", async () => {
  const folder = mkdtempSync(join(tmpdir(), "client-turn-ithaca-"));
  const db = createUiDb(join(folder, "ui.db")), writer = openSqliteWriter(db);
  const store = createOffloopActivityStore(db, writer);
  const gate = new Int32Array(new SharedArrayBuffer(12));
  const release = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
  const timeoutHandle = setTimeout(() => {}, watchdogMs(30000));
  let held: Promise<unknown> | undefined, receipt: Promise<unknown> | undefined;
  const rejected: Promise<unknown>[] = [];
  let lifecycle: ReturnType<typeof createTurnLifecycle> | undefined;
  const frames: unknown[] = [], refused: string[] = [];
  const host = { activity: { store, stream: { pump() {} } }, dialogue: { retireTurn() {} }, log: { emit() {} },
    sendToClients: (frame: unknown) => frames.push(frame), reportDroppedFrame: (reason: string) => refused.push(reason) } as unknown as WsHost;
  try {
    expect(writer.offloop).toBe(true);
    const channel = writer.channel(probe, {}); await channel.ready;
    held = channel.call("hold", gate, watchdogMs(10000));
    const entering = Atomics.waitAsync(gate, 0, 0); if (entering.async) await entering.value;
    lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus");
    const run = { host, turnId: "turn-ithaca", turn: { turnId: "turn-ithaca", sessionId: "ithaca" }, slot: { releaseActive() {} },
      current: { principalId: "odysseus" }, held: {}, stops: {}, failureRecording: { async finish() {} }, lifecycle, timeoutHandle } as unknown as TurnRun;
    await teardownTurn(run, { lifecycle: "success", work: "completed", cancelledBeforeStart: false });
    publishTurnStatus(run, { cancelledBeforeStart: false });
    expect(Atomics.load(gate, 2), "IDLE_PRECEDES_HELD_WRITER_RELEASE").toBe(0);
    expect(frames[0]).toMatchObject({ type: "status", status: "idle", hostTurnComplete: true });
    const report = (principal: string, ms: number) => handleClientMessage(host, {} as never,
      { type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: ms } },
      { principal: testPrincipal(principal), authorization: testAuthorization(principal) });
    let wrongOwnerDone = false, duplicateDone = false;
    rejected.push(report("eurylochus", 99).then(() => { wrongOwnerDone = true; }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(wrongOwnerDone).toBe(true);
    receipt = report("odysseus", 7);
    rejected.push(report("odysseus", 99).then(() => { duplicateDone = true; }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(duplicateDone).toBe(true);
    release(); await held; await receipt; await lifecycle.settled(); await writer.idle();
    expect(refused).toEqual(["client_turn_receipt_refused", "client_turn_receipt_refused"]);
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual({ sendToFirstHostFrameMs: 7 });
  } finally {
    release(); await held; await receipt; await Promise.allSettled(rejected); await lifecycle?.settled(); clearTimeout(timeoutHandle);
    await writer.close(); db.close(); rmSync(folder, { recursive: true, force: true });
  }
});

test("revocation during deferred persistence refuses only that report", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const ready = Promise.withResolvers<void>();
  const refused: string[] = [];
  const host = { activity: { store, stream: { pump() {} } }, reportDroppedFrame: (reason: string) => refused.push(reason) } as unknown as WsHost;
  const life = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus"); life.finish("success");
  const authorization = testAuthorization("odysseus");
  let waiting: Promise<void> | undefined;
  try {
    expect(prepareClientTurnReceipt(host, "turn-ithaca", "odysseus", () => ready.promise)).toBe(true);
    waiting = handleClientMessage(host, {} as never, { type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 7 } },
      { principal: testPrincipal("odysseus"), authorization });
    await new Promise<void>(resolve => setImmediate(resolve));
    (authorization as { valid: boolean }).valid = false;
    ready.resolve(); await waiting;
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toBeUndefined();
    expect(refused).toEqual(["client_turn_receipt_refused"]);
    const other = createTurnLifecycle(store, "turn-troy", "ithaca", 1000, () => {}, () => 1100, "odysseus"); other.finish("success");
    await handleClientMessage(host, {} as never, { type: "client_turn_receipt", turnId: "turn-troy", timing: { sendToFirstHostFrameMs: 9 } },
      { principal: testPrincipal("odysseus"), authorization: testAuthorization("odysseus") });
    expect(store.lifecycle("turn-troy")?.clientTiming).toEqual({ sendToFirstHostFrameMs: 9 });
  } finally { ready.resolve(); await waiting; db.close(); }
});


test("pending receipt capacity drops only new samples and recovers after persistence", async () => {
  const ready = Promise.withResolvers<void>();
  const host = { activity: { store: { writeClientReceipt() {} } } } as unknown as WsHost;
  try {
    for (let index = 0; index < 256; index++) expect(prepareClientTurnReceipt(host, `turn-ithaca-${index}`, "odysseus", () => ready.promise)).toBe(true);
    expect(prepareClientTurnReceipt(host, "turn-troy", "odysseus", () => ready.promise)).toBe(false);
    ready.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(prepareClientTurnReceipt(host, "turn-troy", "odysseus", () => Promise.resolve())).toBe(true);
  } finally { ready.resolve(); }
});
