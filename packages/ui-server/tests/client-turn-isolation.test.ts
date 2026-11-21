import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createActivityStream } from "../src/activity/stream.js";
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
  const { writeClientReceipt: _receipt, ...prior } = createActivityStore(db);
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
      { type: "activity_delta", runId: "lifecycle:turn-ithaca", seq: 1, lifecycle },
      { type: "activity_snapshot", view: "index", spans: [], events: [], highWaterSeq: {}, lifecycles: [lifecycle] },
    ]) expect(parseServerMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
    expect(parseClientMessage(JSON.stringify({ type: "client_turn_receipt", turnId: "turn-ithaca", timing: futureTiming })).ok).toBe(false);
    expect(store.writeClientReceipt!("turn-ithaca", "odysseus", futureTiming)).toBe(false);
  } finally { db.close(); }
});

for (const asynchronous of [false, true]) {
  test(`failed ${asynchronous ? "asynchronous" : "synchronous"} terminal persistence cannot attest committed host completion`, async () => {
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
      const run = { host, turn: { turnId: "turn-ithaca", sessionId: "ithaca" } as never };
      publishTurnStatus(run, { cancelledBeforeStart: false });
      expect(store.lifecycle("turn-ithaca")?.endedAt).toBeNull();
      expect(frames).toEqual([expect.objectContaining({ type: "status", status: "idle" })]);
      expect(frames[0]).not.toHaveProperty("hostTurnComplete");
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
