import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ClientChatMessage, ServerMessage, SessionHistoryMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { handleClientMessage as dispatch } from "../src/ws/dispatch";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization, testPrincipal } from "./helpers/principal";
import { addClient, closeDb, getDb, handleClientMessage, isTurnActive, resetForTests, setBackendsForTests, setMaxConcurrentSessions, testHost, useTestDb } from "./helpers/test-host";

beforeEach(() => { resetForTests(); closeDb(); useTestDb(); });
afterEach(() => { resetForTests(); closeDb(); });

async function settled() {
  for (let i = 0; i < 200; i++) {
    if (!isTurnActive() && testHost().coordinator.startingSessions === 0) return;
    await Bun.sleep(5);
  }
  throw new Error("turn did not settle");
}

function harness(failure: TurnFailure = { errorClass: "server_error", status: 500, message: "Provider failed" }) {
  const calls: StartTurnRequest[] = [];
  const history: SessionHistoryMessage[] = [];
  const frames: ServerMessage[] = [];
  const ws = { send(raw: string) { frames.push(JSON.parse(raw)); } };
  setBackendsForTests([makeFakeBackend({ id: "claude", capabilities: { attachments: true },
    getHistory: async () => history,
    async startTurn(request) {
      calls.push(request);
      request.bridge.emit({ type: "session_info", sessionId: "s1", isNew: calls.length === 1, providerId: "claude" });
      history.push({ role: "user", content: request.prompt, toolCalls: [], attachmentCount: request.attachments?.length ?? 0 });
      history.push({ role: "assistant", content: "Partial", toolCalls: [], failure });
      request.bridge.emit({ type: "text_delta", text: "Partial" });
      request.bridge.emit({ type: "result", sessionId: "s1", numTurns: 1, durationMs: 1, isError: true, outcome: "error", failure });
    },
  })], "claude");
  addClient(ws);
  const original: ClientChatMessage = { type: "chat_message", text: "Describe both images", providerId: "claude",
    attachments: [{ mediaType: "image/png", data: "YWJj" }, { mediaType: "image/jpeg", data: "ZGVm" }],
    client: { formFactor: "phone", locale: "en", touch: true }, source: "voice-dictate" };
  async function fail() {
    await handleClientMessage(ws, original); await settled();
    const result = frames.findLast(f => f.type === "result");
    expect(result?.type).toBe("result");
    if (result?.type !== "result" || !result.retryOfTurnId) throw new Error("failure has no retained handle");
    return result.retryOfTurnId;
  }
  return { calls, history, frames, ws, original, fail };
}

test("Retry after reload starts one distinct turn with nonempty original images and options; repeated delivery is deduplicated", async () => {
  const h = harness(); const failedTurnId = await h.fail();
  await handleClientMessage(h.ws, { type: "session_resume", sessionId: "s1" });
  const replay = h.frames.findLast(f => f.type === "session_history");
  expect(replay?.type === "session_history" && replay.messages.at(-1)?.retryOfTurnId).toBe(failedTurnId);
  expect(h.history[0]?.attachmentCount).toBe(2);
  expect(h.original.attachments).toHaveLength(2);
  expect(h.original.client).not.toEqual({});
  const request = { type: "retry_turn" as const, sessionId: "s1", failedTurnId, requestId: "retry-one" };
  await Promise.all([handleClientMessage(h.ws, request), handleClientMessage(h.ws, request)]);
  await settled();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1].attachments).toEqual(h.calls[0].attachments);
  expect(h.calls[1].client).toEqual(h.calls[0].client);
  expect(h.calls[1].prompt).toBe(h.calls[0].prompt);
  expect(h.calls[1].profileId).toBe(h.calls[0].profileId);
  const results = h.frames.filter(f => f.type === "result");
  expect((results[0] as { turnId?: string })?.turnId).not.toBe((results[1] as { turnId?: string })?.turnId);
  // Simulate a new socket losing the first acknowledgement. Status returns
  // the durable receipt without executing again or replaying prompt bytes.
  const receiptFrames: ServerMessage[] = [];
  await handleClientMessage({ send: raw => receiptFrames.push(JSON.parse(raw)) }, { type: "retry_status", sessionId: "s1", requestId: request.requestId });
  expect(receiptFrames).toEqual([{ type: "retry_receipt", sessionId: "s1", requestId: "retry-one", state: "accepted" }]);
  expect(h.calls).toHaveLength(2);
  expect(getDb().query("SELECT COUNT(*) AS n FROM retry_receipts").get()).toEqual({ n: 1 });
});

test("a later accepted input invalidates a historical handle", async () => {
  const h = harness(); const failedTurnId = await h.fail();
  await handleClientMessage(h.ws, { type: "chat_message", sessionId: "s1", text: "A different input" }); await settled();
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "old-turn" });
  expect(h.calls).toHaveLength(2);
  expect(h.frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" });
});

test("another principal cannot consume a retained request or read its receipt", async () => {
  const h = harness(); const failedTurnId = await h.fail();
  const connection = { authorization: testAuthorization("principal-b"), principal: testPrincipal("principal-b") };
  await dispatch(testHost(), h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "other-principal" }, connection);
  expect(h.calls).toHaveLength(1);
  expect(h.frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" });
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "owner-retry" }); await settled();
  await dispatch(testHost(), h.ws, { type: "retry_status", sessionId: "s1", requestId: "owner-retry" }, connection);
  expect(h.frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "unknown" });
});

test("an unknown failure permits one manual retry and then omits its retry handle", async () => {
  const h = harness({ errorClass: "unknown", message: "Unclassified failure" }); const failedTurnId = await h.fail();
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "unknown-once" }); await settled();
  const result = h.frames.findLast(f => f.type === "result");
  expect(result?.type === "result" && result.retryOfTurnId).toBeUndefined();
  expect(getDb().query("SELECT COUNT(*) AS n FROM retry_requests").get()).toEqual({ n: 0 });
});


test("a capacity refusal is queryable without losing the original request; a fresh retry recovers", async () => {
  const h = harness(); const failedTurnId = await h.fail();
  setMaxConcurrentSessions(0);
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "capacity-refused" });
  expect(h.frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" });
  await handleClientMessage(h.ws, { type: "retry_status", sessionId: "s1", requestId: "capacity-refused" });
  expect(h.frames.at(-1)).toMatchObject({ type: "retry_receipt", state: "refused" });
  expect(h.calls).toHaveLength(1);
  setMaxConcurrentSessions(1);
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "capacity-refused" });
  expect(h.calls).toHaveLength(1);
  await handleClientMessage(h.ws, { type: "retry_turn", sessionId: "s1", failedTurnId, requestId: "capacity-recovered" }); await settled();
  expect(h.calls).toHaveLength(2);
});

test("failed retry invalidation releases an unqueued follow-up's authorization lease", async () => {
  const gate = Promise.withResolvers<void>();
  setBackendsForTests([makeFakeBackend({ id: "claude", async startTurn(request) {
    request.bridge.emit({ type: "session_info", sessionId: "s1", isNew: true });
    await gate.promise;
    request.bridge.emit({ type: "result", sessionId: "s1", numTurns: 1, durationMs: 1, isError: false });
  } })], "claude");
  const ws = { send() {} };
  await handleClientMessage(ws, { type: "chat_message", text: "First input" });
  for (let i = 0; !testHost().coordinator.bySession.has("s1") && i < 200; i++) await Bun.sleep(5);
  expect(testHost().coordinator.bySession.has("s1")).toBe(true);
  let retained = 0, released = 0;
  const authorization = { ...testAuthorization(), retain: () => { retained++; return () => { released++; }; } };
  const catalog = testHost().catalog;
  const clear = catalog.clearRetryRequest;
  catalog.clearRetryRequest = () => { throw new Error("invalidation failed"); };
  try {
    await expect(dispatch(testHost(), ws, { type: "chat_message", sessionId: "s1", text: "Follow up" }, { authorization, principal: testPrincipal() })).rejects.toThrow("invalidation failed");
    expect(retained).toBe(1);
    expect(released).toBe(1);
    expect(testHost().coordinator.bySession.get("s1")?.queue).toHaveLength(0);
  } finally { catalog.clearRetryRequest = clear; gate.resolve(); await settled(); }
});
