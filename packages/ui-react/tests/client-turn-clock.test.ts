import { expect, test } from "bun:test";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createTurnClock } from "../src/ws-client/turn-clock.js";

function scene() {
  let now = 1000;
  const reports: ClientMessage[] = [];
  const clock = createTurnClock(message => { reports.push(message); return true; }, () => now);
  const send = (requestId = "voyage") => clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId }, clock.now());
  const frame = (at: number, message: Parameters<typeof clock.frame>[0] & { turnId?: string }) => { now = at; clock.frame(message); };
  return { reports, clock, send, frame };
}
test("queued first host, thinking/text content and idle use one monotonic client clock and report once", () => {
  const s = scene(); s.send();
  s.frame(1004, { type: "status", status: "queued", requestId: "voyage", sessionId: "ithaca" });
  s.frame(1020, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1050, { type: "text_delta", text: "Other turn", turnId: "turn-troy", sessionId: "troy" });
  s.frame(1100, { type: "thinking_delta", text: "", turnId: "turn-ithaca" });
  s.frame(1204, { type: "thinking_delta", text: "Check the winds", turnId: "turn-ithaca" });
  s.frame(1300, { type: "text_delta", text: "Sail at dawn", turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.frame(1308, { type: "status", status: "idle", turnId: "turn-ithaca" });
  s.frame(1400, { type: "status", status: "idle", turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 4, sendToFirstContentFrameMs: 204, lastContentFrameToIdleMs: 8,
  } }]);
});
test("disconnect discards incomplete evidence and a later turn can still report", () => {
  const s = scene(); s.send();
  s.frame(1010, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.clock.disconnected();
  s.frame(1200, { type: "status", status: "idle", turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.send("return");
  s.frame(1210, { type: "session_info", isNew: false, requestId: "return", turnId: "turn-return", sessionId: "ithaca" });
  s.frame(1220, { type: "status", status: "idle", turnId: "turn-return" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-return", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("frames before the request's identity are measured without adopting another client's turn", () => {
  const s = scene(); s.send();
  s.frame(1001, { type: "status", status: "thinking", turnId: "turn-troy" });
  s.frame(1005, { type: "status", status: "thinking", turnId: "turn-ithaca" });
  s.frame(1100, { type: "thinking_delta", text: "Check the winds", turnId: "turn-ithaca" });
  s.frame(1105, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1120, { type: "status", status: "idle", turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 5, sendToFirstContentFrameMs: 100, lastContentFrameToIdleMs: 20,
  } }]);
});

test("a lost report is attempted once even when the socket throws, and later turns still report", () => {
  const attempts: ClientMessage[] = [];
  const clock = createTurnClock(message => { attempts.push(message); throw new Error("Socket closed"); }, () => 1100);
  clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" }, 1000);
  const identity = { type: "session_info" as const, isNew: true, sessionId: "ithaca", turnId: "turn-ithaca", requestId: "voyage" };
  clock.frame(identity);
  const idle = { type: "status" as const, status: "idle" as const, turnId: "turn-ithaca" };
  expect(() => clock.frame(idle)).not.toThrow();
  clock.frame(idle);
  expect(attempts).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 100 } }]);
  clock.sent({ type: "chat_message", text: "Return to Ithaca", requestId: "return" }, 1000);
  clock.frame({ ...identity, turnId: "turn-return", requestId: "return" });
  clock.frame({ ...idle, turnId: "turn-return" });
  expect(attempts).toHaveLength(2);
});
