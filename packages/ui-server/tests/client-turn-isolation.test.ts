import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityStream } from "../src/activity/stream.js";
import { runActivityQuery } from "../src/activity/query.js";
import { WsHost } from "../src/ws/host.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { FrameRateLimiter } from "../src/ws/rate-limit.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testPrincipal } from "./helpers/principal.js";
import type { WSContext } from "../src/ws/clients.js";

const timing = { sendToFirstHostFrameMs: 5 };
function completed(store: ReturnType<typeof createActivityStore>, turnId: string, at = 1000) {
  const lifecycle = createTurnLifecycle(store, turnId, "ithaca", at, () => {}, () => at + 100, "odysseus");
  lifecycle.finish("success");
}

test("one malformed client receipt leaves host records, other receipts and Activity deltas usable", () => {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db);
  completed(store, "turn-ithaca"); completed(store, "turn-troy");
  const stream = createActivityStream(store);
  try {
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true);
    expect(store.writeClientReceipt!("turn-troy", "odysseus", timing)).toBe(true);
    db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run("{broken", "turn-ithaca");
    expect(store.lifecycle("turn-ithaca")).toMatchObject({ outcome: "success", clientTimingUnavailable: "invalid_receipt" });
    expect(store.lifecycle("turn-ithaca")?.clientTiming).toBeUndefined();
    expect(store.lifecycles()).toHaveLength(2);
    const frames: Array<{ type: string; lifecycle?: { turnId: string; clientTiming?: unknown } }> = [];
    const ws: WSContext = { send: text => frames.push(JSON.parse(text)) };
    stream.handleSubscribe(ws, { type: "activity_subscribe", view: "index" }, "odysseus");
    stream.pump();
    expect(frames.filter(frame => frame.type === "activity_delta").map(frame => frame.lifecycle?.turnId)).toEqual(["turn-ithaca", "turn-troy"]);
    expect(frames.at(-1)?.lifecycle).toMatchObject({ turnId: "turn-troy", clientTiming: timing });
    db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run('{"sendToFirstHostFrameMs":-1}', "turn-ithaca");
    expect(store.lifecycleChangesSince(0).at(-2)?.lifecycle).toMatchObject({ turnId: "turn-ithaca", clientTimingUnavailable: "invalid_receipt" });
    db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run(" ".repeat(5000) + JSON.stringify(timing), "turn-ithaca");
    expect(store.lifecycle("turn-ithaca")?.clientTimingUnavailable).toBe("invalid_receipt");
    expect(store.lifecycle("turn-troy")?.clientTiming).toEqual(timing);
  } finally { stream.close(); db.close(); }
});

for (const stage of ["lifecycle-only", "snapshot", "pruned"] as const) {
  test(`client receipt never enters provider-facing ${stage} Activity tool results`, () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db);
    const descriptor = Object.getOwnPropertyDescriptor(Date, "now")!;
    const at = Date.UTC(2026, 6, 12);
    Object.defineProperty(Date, "now", { ...descriptor, value: () => at + 1000 });
    try {
      completed(store, "turn-ithaca", at);
      if (stage !== "lifecycle-only") {
        store.startSpan({ spanId: "root", runId: "turn-ithaca", name: "invoke_agent", kind: "turn", origin: "session", startedAt: at });
        store.endSpan("root", { outcome: "success", endedAt: at + 100 }); store.rollupRun("turn-ithaca");
      }
      if (stage === "pruned") store.prune({ digestFloorAt: at + 1000, detailRetentionMs: 0, hardCeilingMs: 0, now: at + 1000 });
      const read = () => JSON.stringify([
        runActivityQuery(db, store, { scope: "run", runId: "turn-ithaca" }),
        runActivityQuery(db, store, { scope: "recent" }),
      ]);
      const before = read();
      expect(store.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true);
      expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(timing);
      expect(read()).toBe(before);
      expect(read()).not.toContain("clientTiming");
      db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run("{broken", "turn-ithaca");
      expect(store.lifecycle("turn-ithaca")?.clientTimingUnavailable).toBe("invalid_receipt");
      expect(read()).toBe(before);
      expect(read()).not.toContain("clientTimingUnavailable");
    } finally { Object.defineProperty(Date, "now", descriptor); db.close(); }
  });
}


for (const invalid of [false, true]) {
  test(`${invalid ? "schema-invalid" : "rate-limited"} receipt never interrupts voice or emits a draft-affecting error`, async () => {
    const db = createUiDb(":memory:");
    const backend = makeFakeBackend({ id: "odyssey" });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
    host.newRateLimiter = () => new FrameRateLimiter({ ratePerSecond: 1, burst: 1, clock: { now: () => 0 } });
    let voiceActive = true;
    Object.defineProperty(host, "conversations", { value: { frameDropped() { voiceActive = false; }, closeAll() {} } });
    const sent: unknown[] = [];
    const pong = Promise.withResolvers<void>();
    const ws: WSContext = { send: text => { const message = JSON.parse(text); sent.push(message); if (message.type === "pong") pong.resolve(); } };
    const handlers = createWsHandlers(host, testPrincipal("odysseus"));
    const message = { type: "client_turn_receipt", turnId: "turn-ithaca", timing: invalid ? { sendToFirstHostFrameMs: -1 } : timing };
    try {
      handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
      if (!invalid) handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
      expect(sent).toEqual([]);
      expect(voiceActive).toBe(true);
      handlers.onMessage({ data: JSON.stringify({ type: "ping", probeId: "return-to-ithaca" }) } as MessageEvent, ws);
      await pong.promise;
      expect(sent).toEqual([{ type: "pong", probeId: "return-to-ithaca" }]);
    } finally { await host.close(); db.close(); }
  });
}

test("a prior ActivityStore implementation remains assignable and does not advertise receipt support", async () => {
  const { createActivityRuntime } = await import("../src/activity/runtime.js");
  const { createSilentObservability } = await import("../src/observability/index.js");
  const db = createUiDb(":memory:");
  const { writeClientReceipt: _receipt, snapshotLifecycles: _snapshot, ...prior } = createActivityStore(db);
  // This assignment is also compile-time proof for consumers implementing the previous interface.
  const compatible: import("../src/activity/store.js").ActivityStore = prior;
  const observability = createSilentObservability();
  const activity = createActivityRuntime(db, { log: observability.logger("test") });
  activity.store = compatible;
  const backend = makeFakeBackend({ id: "odyssey" });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db), activity });
  const frames: Array<{ type: string; capabilities?: Record<string, boolean> }> = [];
  const ws: WSContext = { send: text => frames.push(JSON.parse(text)) };
  try {
    await createWsHandlers(host, testPrincipal("odysseus")).onOpen(undefined as never, ws);
    expect(frames.find(frame => frame.type === "server_hello")?.capabilities?.clientTurnReceipts).toBeUndefined();
    expect(compatible.lifecycle("turn-missing")).toBeNull();
  } finally { await host.close(); await activity.close(); db.close(); }
});

test("the initial thinking for an accepted existing session carries its request correlation", async () => {
  const { handleChatMessage } = await import("../src/ws/run-session.js");
  const { testAuthorization } = await import("./helpers/principal.js");
  const db = createUiDb(":memory:");
  const catalog = createSessionCatalog(() => db);
  const backend = makeFakeBackend({ id: "odyssey" });
  catalog.persistSessionStub("ithaca", "Plan Ithaca", null, backend.id);
  await catalog.settled?.();
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog });
  const frames: unknown[] = [];
  const ws: WSContext = { send: text => frames.push(JSON.parse(text)) };
  host.clients.add(ws, "odysseus");
  try {
    await handleChatMessage(host, ws, { text: "Return to Ithaca", sessionId: "ithaca", requestId: "voyage", attachments: [], authorization: testAuthorization("odysseus") });
    expect(frames[0]).toMatchObject({ type: "status", status: "thinking", sessionId: "ithaca", requestId: "voyage" });
  } finally { await host.close(); await Promise.allSettled([...host.turnTasks]); db.close(); }
});

test("embedded NUL and damaged suffix never turn corrupt storage into valid timing", () => {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db);
  try {
    completed(store, "turn-ithaca"); completed(store, "turn-troy");
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true);
    expect(store.writeClientReceipt!("turn-troy", "odysseus", timing)).toBe(true);
    for (const suffix of ["\u0000damaged", "\u0000" + "x".repeat(5000)]) {
      db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run(JSON.stringify(timing) + suffix, "turn-ithaca");
      expect(store.lifecycle("turn-ithaca")).toMatchObject({ outcome: "success", clientTimingUnavailable: "invalid_receipt" });
      expect(store.lifecycle("turn-ithaca")?.clientTiming).toBeUndefined();
      expect(store.lifecycleChangesSince(0).at(-2)?.lifecycle.clientTimingUnavailable).toBe("invalid_receipt");
      expect(store.lifecycle("turn-troy")?.clientTiming).toEqual(timing);
    }
  } finally { db.close(); }
});

test("server timing reads preserve unknown optional keys while client writes reject them", async () => {
  const { parseServerMessage, parseClientMessage } = await import("@schlessera/brain-ui-sdk/schemas");
  const db = createUiDb(":memory:");
  const store = createActivityStore(db);
  try {
    completed(store, "turn-ithaca");
    const futureTiming = { ...timing, futureArrivalMs: 7 };
    const lifecycle = { ...store.lifecycle("turn-ithaca")!, clientTiming: futureTiming };
    for (const frame of [
      { type: "activity_delta" as const, runId: "lifecycle:turn-ithaca", seq: 1, lifecycle },
      { type: "activity_snapshot" as const, view: "index" as const, spans: [], events: [], highWaterSeq: {}, lifecycles: [lifecycle] },
    ]) expect(parseServerMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
    expect(parseClientMessage(JSON.stringify({ type: "client_turn_receipt", turnId: "turn-ithaca", timing: futureTiming })).ok).toBe(false);
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", futureTiming)).toBe(false);
  } finally { db.close(); }
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? "asynchronous" : "synchronous"} terminal timing failure cannot change in-memory host completion`, async () => {
    const { publishTurnStatus } = await import("../src/ws/session-run/teardown.js");
    const db = createUiDb(":memory:");
    const store = createActivityStore(db);
    const frames: unknown[] = [];
    try {
      const writes = Object.create(store) as import("../src/activity/store.js").AwaitableActivityStore;
      writes.writeLifecycle = (record, owner) => {
        if (record.endedAt !== null) {
          if (asynchronous) return Promise.reject(new Error("terminal write refused"));
          throw new Error("terminal write refused");
        }
        return store.writeLifecycle(record, owner);
      };
      const lifecycle = createTurnLifecycle(writes, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus");
      lifecycle.finish("success"); await lifecycle.settled();
      const host = { activity: { store }, sendToClients: (frame: unknown) => frames.push(frame), log: { emit() {} } } as unknown as WsHost;
      const run = { host, turn: { turnId: "turn-ithaca", sessionId: "ithaca" } as never, clientReceiptEligible: true };
      publishTurnStatus(run, { cancelledBeforeStart: false });
      expect(store.lifecycle("turn-ithaca")?.endedAt).toBeNull();
      expect(frames).toEqual([expect.objectContaining({ type: "status", status: "idle" })]);
      expect(frames[0]).toHaveProperty("hostTurnComplete", true);
      completed(store, "turn-troy");
      publishTurnStatus({ ...run, turn: { turnId: "turn-troy", sessionId: "ithaca" } as never }, { cancelledBeforeStart: false });
      expect(frames[1]).toHaveProperty("hostTurnComplete", true);
    } finally { db.close(); }
  });
}

test("exhausted ordinary and receipt buckets do not JSON-decode another payload", async () => {
  const db = createUiDb(":memory:");
  const backend = makeFakeBackend({ id: "odyssey" });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
  host.newRateLimiter = () => new FrameRateLimiter({ ratePerSecond: 1, burst: 1, clock: { now: () => 0 } });
  const handlers = createWsHandlers(host, testPrincipal("odysseus"));
  const ws: WSContext = { send() {} };
  const ordinary = JSON.stringify({ type: "ping" });
  const receipt = JSON.stringify({ timing, turnId: "turn-ithaca", type: "client_turn_receipt" });
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "parse")!;
  const parse = JSON.parse;
  const decoded: string[] = [];
  try {
    handlers.onMessage({ data: ordinary } as MessageEvent, ws);
    handlers.onMessage({ data: receipt } as MessageEvent, ws);
    Object.defineProperty(JSON, "parse", { ...descriptor, value: (text: string, ...args: unknown[]) => { decoded.push(text); return Reflect.apply(parse, JSON, [text, ...args]); } });
    handlers.onMessage({ data: ordinary } as MessageEvent, ws);
    handlers.onMessage({ data: receipt } as MessageEvent, ws);
    expect(decoded).toEqual([]);
  } finally { Object.defineProperty(JSON, "parse", descriptor); await host.close(); db.close(); }
});

test("receipt corruption limits count bytes rather than UTF-16 characters", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    completed(store, "turn-ithaca");
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true);
    // The overwritten duplicate leaves a valid numeric object after JSON.parse,
    // while its original UTF-8 bytes still count toward the storage boundary.
    const head = '{"sendToFirstHostFrameMs":"' + "é".repeat(2000) + '","sendToFirstHostFrameMs":7}';
    const padded = (bytes: number) => head + " ".repeat(bytes - Buffer.byteLength(head));
    for (const [value, valid] of [[padded(4096), true], [padded(4097), false], [padded(4097) + "damaged", false]] as const) {
      db.query("UPDATE activity_turn_clients SET receipt = ? WHERE turn_id = ?").run(value, "turn-ithaca");
      const record = store.lifecycle("turn-ithaca")!;
      expect(record.clientTiming).toEqual(valid ? { sendToFirstHostFrameMs: 7 } : undefined);
      expect(record.clientTimingUnavailable).toBe(valid ? undefined : "invalid_receipt");
    }
  } finally { db.close(); }
});

test("stalled lifecycle timing cannot hold final idle or the next queued turn", async () => {
  const { teardownTurn, publishTurnStatus } = await import("../src/ws/session-run/teardown.js");
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const terminal = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  let done = false, nextStarted = false, released = false;
  const writes = Object.create(store) as import("../src/activity/store.js").AwaitableActivityStore;
  writes.writeLifecycle = (record, owner) => {
    if (record.endedAt !== null) { entered.resolve(); return terminal.promise.then(() => store.writeLifecycle(record, owner)); }
    return store.writeLifecycle(record, owner);
  };
  // Missing receipt support is deliberate: telemetry cannot delay either host.
  Object.defineProperty(writes, "writeClientReceipt", { value: undefined });
  const lifecycle = createTurnLifecycle(writes, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus");
  const host = { activity: { store: writes }, dialogue: { retireTurn() {} }, log: { emit() {} }, sendToClients: (frame: unknown) => frames.push(frame) } as unknown as WsHost;
  const { watchdogMs } = await import("../../../scripts/test-deadlines.ts");
  const timeoutHandle = setTimeout(() => {}, watchdogMs(30000));
  const run = { host, turn: { turnId: "turn-ithaca", sessionId: "ithaca" }, slot: { releaseActive() { released = true; } },
    current: {}, held: {}, stops: {}, failureRecording: { async finish() {} }, lifecycle, timeoutHandle } as unknown as import("../src/ws/session-run/types.js").TurnRun;
  const task = teardownTurn(run, { lifecycle: "success", work: "completed", cancelledBeforeStart: false }).then(() => {
    publishTurnStatus(run, { cancelledBeforeStart: false }); done = true; nextStarted = true;
  });
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(released).toBe(true);
    expect(done).toBe(true);
    expect(nextStarted).toBe(true);
    expect(frames[0]).toMatchObject({ type: "status", status: "idle" });
    expect(frames[0]).not.toHaveProperty("hostTurnComplete");
  } finally { terminal.resolve(); await task; await lifecycle.settled(); clearTimeout(timeoutHandle); db.close(); }
});
