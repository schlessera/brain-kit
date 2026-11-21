import { expect, test } from "bun:test";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createTurnClock } from "../src/ws-client/turn-clock.js";

function scene(supported = true) {
  let now = 1000;
  const reports: ClientMessage[] = [];
  const clock = createTurnClock(message => { reports.push(message); return true; }, () => now);
  clock.frame({ type: "server_hello", protocolRev: 5, capabilities: supported ? { clientTurnReceipts: true } : {} });
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
  s.frame(1308, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  s.frame(1400, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 4, sendToFirstContentFrameMs: 204, lastContentFrameToIdleMs: 8,
  } }]);
});
test("disconnect discards incomplete evidence and a later turn can still report", () => {
  const s = scene(); s.send();
  s.frame(1010, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.clock.disconnected();
  s.frame(1200, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.frame(1200, { type: "server_hello", protocolRev: 5, capabilities: { clientTurnReceipts: true } });
  s.send("return");
  s.frame(1210, { type: "session_info", isNew: false, requestId: "return", turnId: "turn-return", sessionId: "ithaca" });
  s.frame(1220, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-return" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-return", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("frames before the request's identity are measured without adopting another client's turn", () => {
  const s = scene(); s.send();
  s.frame(1001, { type: "status", status: "thinking", turnId: "turn-troy" });
  s.frame(1005, { type: "status", status: "thinking", turnId: "turn-ithaca" });
  s.frame(1100, { type: "thinking_delta", text: "Check the winds", turnId: "turn-ithaca" });
  s.frame(1105, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1120, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 5, sendToFirstContentFrameMs: 100, lastContentFrameToIdleMs: 20,
  } }]);
});

test("a lost report is attempted once even when the socket throws, and later turns still report", () => {
  const attempts: ClientMessage[] = [];
  const clock = createTurnClock(message => { attempts.push(message); throw new Error("Socket closed"); }, () => 1100);
  clock.frame({ type: "server_hello", protocolRev: 5, capabilities: { clientTurnReceipts: true } });
  clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" }, 1000);
  const identity = { type: "session_info" as const, isNew: true, sessionId: "ithaca", turnId: "turn-ithaca", requestId: "voyage" };
  clock.frame(identity);
  const idle = { type: "status" as const, status: "idle" as const, hostTurnComplete: true as const, turnId: "turn-ithaca" };
  expect(() => clock.frame(idle)).not.toThrow();
  clock.frame(idle);
  expect(attempts).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 100 } }]);
  clock.sent({ type: "chat_message", text: "Return to Ithaca", requestId: "return" }, 1000);
  const returnIdentity = { ...identity, turnId: "turn-return", requestId: "return" };
  clock.frame(returnIdentity);
  clock.frame({ ...idle, turnId: "turn-return" });
  expect(attempts).toHaveLength(2);
});


test("a host that does not advertise receipt support receives no unknown timing message", () => {
  const s = scene(false); s.send();
  s.frame(1010, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1200, { type: "text_delta", text: "Sail at dawn", turnId: "turn-ithaca" });
  s.frame(1220, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.clock.disconnected();
  s.frame(1230, { type: "server_hello", protocolRev: 5, capabilities: { clientTurnReceipts: true } });
  s.send("return");
  s.frame(1240, { type: "session_info", isNew: false, requestId: "return", turnId: "turn-return", sessionId: "ithaca" });
  s.frame(1250, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-return" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-return", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("backend idle cannot complete the measurement before host teardown", () => {
  const s = scene(); s.send();
  s.frame(1010, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1100, { type: "text_delta", text: "Sail at dawn", turnId: "turn-ithaca" });
  s.frame(1110, { type: "status", status: "idle", turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.frame(1300, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 10, sendToFirstContentFrameMs: 100, lastContentFrameToIdleMs: 200,
  } }]);
});

test("accepted retry acknowledgement is the first host frame before retry dispatch", () => {
  const s = scene();
  s.clock.sent({ type: "retry_turn", sessionId: "ithaca", failedTurnId: "turn-troy", requestId: "voyage" }, 1000);
  s.frame(1005, { type: "retry_receipt", state: "accepted", sessionId: "ithaca", requestId: "voyage" });
  s.frame(1090, { type: "session_info", isNew: false, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1200, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 5 } }]);
});

test("evicting an uncorrelated arrival invalidates the pending request rather than inventing a later first frame", () => {
  const s = scene(); s.send();
  s.frame(1001, { type: "text_delta", text: "Check the winds", turnId: "turn-ithaca" });
  for (let index = 0; index < 256; index++) s.frame(1002 + index, { type: "text_delta", text: "Other voyage", turnId: `turn-troy-${index}` });
  s.frame(1259, { type: "text_delta", text: "Sail at dawn", turnId: "turn-ithaca" });
  s.frame(1260, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1270, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
  s.send("return");
  s.frame(1280, { type: "session_info", isNew: false, requestId: "return", turnId: "turn-return", sessionId: "ithaca" });
  s.frame(1290, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-return" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-return", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("initial thinking acknowledgement is correlated before an existing session's new turn identity", () => {
  const s = scene(); s.send();
  s.frame(1010, { type: "status", status: "thinking", requestId: "voyage", sessionId: "ithaca" });
  s.frame(1090, { type: "session_info", isNew: false, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1200, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("lifecycle arrivals before identity count as first host frames for deltas and snapshots", () => {
  for (const type of ["activity_delta", "activity_snapshot"] as const) {
    const s = scene(); s.send();
    const lifecycle = { turnId: "turn-ithaca" } as import("@schlessera/brain-ui-sdk/protocol").ActivityTurnLifecycle;
    s.frame(1005, type === "activity_delta"
      ? { type, runId: "lifecycle:turn-ithaca", seq: 1, lifecycle }
      : { type, view: "index", spans: [], events: [], highWaterSeq: {}, lifecycles: [lifecycle] });
    s.frame(1080, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
    s.frame(1100, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
    expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 5 } }]);
  }
});

test("a Send boundary survives snapshot persistence and is not reset by socket dispatch", () => {
  const s = scene();
  s.clock.started("voyage", 500);
  s.send();
  s.frame(1010, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1200, { type: "text_delta", text: "Sail at dawn", turnId: "turn-ithaca" });
  s.frame(1220, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: {
    sendToFirstHostFrameMs: 510, sendToFirstContentFrameMs: 700, lastContentFrameToIdleMs: 20,
  } }]);
});

test("a snapshot whose Send boundary was lost cannot invent one at later dispatch", () => {
  for (const lost of ["eviction", "reload"] as const) {
    const s = scene();
    s.clock.started("voyage", 500);
    if (lost === "eviction") {
      for (let index = 0; index < 256; index++) s.clock.started(`other-voyage-${index}`, 1000 + index);
    } else {
      s.clock.disconnected();
      s.frame(1300, { type: "server_hello", protocolRev: 5, capabilities: { clientTurnReceipts: true } });
    }
    s.clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage", draftRef: { draftId: "draft-ithaca", revision: 1 } }, 1300);
    s.frame(1310, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
    s.frame(1400, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
    expect(s.reports).toEqual([]);
  }
});

test("saving Send in one tab does not authorize a receipt for another tab's dispatch", () => {
  const observer = scene(), sender = scene();
  observer.send("other-local"); // An unrelated local dispatch must not admit the held send either.
  observer.clock.started("voyage", 0);
  sender.clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" }, 990);
  for (const s of [observer, sender]) {
    s.frame(1000, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
    s.frame(1010, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  }
  expect(observer.reports).toEqual([]);
  expect(sender.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 10 } }]);
});

test("session_queue started identifies a queued turn that fails before session_info", () => {
  const s = scene(); s.send();
  s.frame(1002, { type: "status", status: "queued", requestId: "voyage", sessionId: "ithaca" });
  s.frame(1010, { type: "session_queue", sessionId: "ithaca", followUps: [], started: {
    id: "queued-voyage", requestId: "voyage", turnId: "turn-ithaca", text: "Plan Ithaca", queuedAt: 0,
  } });
  s.frame(1020, { type: "result", sessionId: "ithaca", turnId: "turn-ithaca", outcome: "error", isError: true, costUsd: 0, durationMs: 0, numTurns: 0 });
  s.frame(1030, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 2 } }]);
});

test("pre-dispatch arrivals retained for another request cannot become a later sender's first frame", () => {
  const s = scene(); s.send("other-local"); s.clock.started("voyage", 0);
  s.frame(1000, { type: "status", status: "thinking", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" }, 1010);
  s.frame(1015, { type: "session_info", isNew: true, requestId: "voyage", turnId: "turn-ithaca", sessionId: "ithaca" });
  s.frame(1020, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([]);
});

test("a pending session_queue entry is itself the first correlated host acknowledgement", () => {
  const s = scene(); s.send();
  const entry = { id: "queued-voyage", requestId: "voyage", text: "Plan Ithaca", queuedAt: 0 };
  s.frame(1002, { type: "session_queue", sessionId: "ithaca", followUps: [entry] });
  s.frame(1010, { type: "session_queue", sessionId: "ithaca", followUps: [], started: { ...entry, turnId: "turn-ithaca" } });
  s.frame(1030, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
  expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 2 } }]);
});

for (const kind of ["status", "session_queue"] as const) {
  test(`a peer's ${kind} acknowledgement before local dispatch disqualifies the shared request`, () => {
    const s = scene(); s.clock.started("voyage", 1000);
    const entry = { id: "queued-voyage", requestId: "voyage", text: "Plan Ithaca", queuedAt: 0 };
    s.frame(1005, kind === "status" ? { type: "status", status: "queued", sessionId: "ithaca", requestId: "voyage" }
      : { type: "session_queue", sessionId: "ithaca", followUps: [entry] });
    s.clock.sent({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" }, 1010);
    s.frame(1030, { type: "session_queue", sessionId: "ithaca", followUps: [], started: { ...entry, turnId: "turn-ithaca" } });
    s.frame(1040, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-ithaca" });
    expect(s.reports).toEqual([]);
    s.send("return");
    s.frame(1050, { type: "session_info", isNew: false, requestId: "return", turnId: "turn-return", sessionId: "ithaca" });
    s.frame(1060, { type: "status", status: "idle", hostTurnComplete: true, turnId: "turn-return" });
    expect(s.reports).toEqual([{ type: "client_turn_receipt", turnId: "turn-return", timing: { sendToFirstHostFrameMs: 10 } }]);
  });
}
