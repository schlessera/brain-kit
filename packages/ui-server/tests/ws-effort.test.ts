import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers } from "../src/ws/connection.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testPrincipal } from "./helpers/principal.js";
import { addClient, closeDb, handleClientMessage, isTurnActive, resetForTests, setBackendsForTests, testHost, useTestDb } from "./helpers/test-host.js";

beforeEach(() => { resetForTests(); closeDb(); useTestDb(); });
afterEach(() => { resetForTests(); closeDb(); });
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error("effort turn did not settle");
}

test("overrides and defaults stay with their queued requests; confirmed effort survives history", async () => {
  const calls: StartTurnRequest[] = [];
  const frames: ServerMessage[] = [];
  const prompts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let nativeFollowUps = 0;
  setBackendsForTests([makeFakeBackend({ id: "pi", capabilities: { followUp: true },
    profiles: [{ id: "test", label: "Test" }],
    async followUp() { nativeFollowUps++; },
    async getHistory() { return prompts.map((content) => ({ role: "user" as const, content, toolCalls: [] })); },
    async startTurn(req) {
      calls.push(req); prompts.push(req.prompt);
      req.bridge.emit({ type: "session_info", sessionId: "effort-session", providerId: "test", isNew: calls.length === 1,
        ...(req.thinkingLevel !== undefined ? { effectiveThinkingLevel: req.thinkingLevel === "max" ? "high" as const : req.thinkingLevel } : {}) });
      if (calls.length === 1) await held;
      req.bridge.emit({ type: "result", sessionId: "effort-session", durationMs: 1, numTurns: 1, isError: false });
    },
  })], "pi");
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
  addClient(ws);
  await handleClientMessage(ws, { type: "chat_message", text: "first", providerId: "test", thinkingLevel: "max", requestId: "first" });
  await until(() => calls.length === 1);
  expect(frames.find((frame) => frame.type === "session_info")).toMatchObject({ requestId: "first", thinkingLevel: "max", effectiveThinkingLevel: "high" });
  await handleClientMessage(ws, { type: "chat_message", sessionId: "effort-session", text: "second", thinkingLevel: "low", requestId: "second" });
  await handleClientMessage(ws, { type: "chat_message", sessionId: "effort-session", text: "third", requestId: "third" });
  expect(calls).toHaveLength(1);
  expect(nativeFollowUps).toBe(0);
  expect(frames.filter((frame) => frame.type === "status" && frame.status === "queued").map((frame) => "requestId" in frame ? frame.requestId : undefined)).toEqual(["second", "third"]);
  release();
  await until(() => calls.length === 3 && !isTurnActive());
  expect(calls.map((req) => req.thinkingLevel)).toEqual(["max", "low", undefined]);
  await handleClientMessage(ws, { type: "session_resume", sessionId: "effort-session" });
  const history = frames.findLast((frame) => frame.type === "session_history");
  expect(history?.type).toBe("session_history");
  if (history?.type !== "session_history") throw new Error("history missing");
  expect(history.messages).toHaveLength(3);
  expect(history.messages[0]).toMatchObject({ thinkingLevel: "max", effectiveThinkingLevel: "high" });
  expect(history.messages[1]).toMatchObject({ thinkingLevel: "low", effectiveThinkingLevel: "low" });
  expect(history.messages[2].thinkingLevel).toBeUndefined();
});

test("invalid effort is rejected on the socket before backend execution; a valid control reaches it", async () => {
  const calls: StartTurnRequest[] = [];
  const frames: ServerMessage[] = [];
  setBackendsForTests([makeFakeBackend({ id: "claude", async startTurn(req) {
    calls.push(req);
    req.bridge.emit({ type: "session_info", sessionId: "validation-session", isNew: true });
    req.bridge.emit({ type: "result", sessionId: "validation-session", durationMs: 1, numTurns: 1, isError: false });
  } })], "claude");
  const ws = { send: (raw: string) => frames.push(JSON.parse(raw)) };
  const handlers = createWsHandlers(testHost(), testPrincipal());
  handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "invalid", thinkingLevel: "enormous" }) } as MessageEvent, ws);
  await Bun.sleep(10);
  expect(frames.find((frame) => frame.type === "error")).toMatchObject({ code: "PARSE_ERROR" });
  expect(calls).toHaveLength(0);
  handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "valid", thinkingLevel: "medium" }) } as MessageEvent, ws);
  await until(() => calls.length === 1);
  expect(calls[0].thinkingLevel).toBe("medium");
});
