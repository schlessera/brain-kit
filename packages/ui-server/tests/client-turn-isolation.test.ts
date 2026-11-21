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
