import { expect, test } from "bun:test";
import { parseClientMessage, parseServerMessage } from "../src/schemas.js";

const receipt = { type: "client_turn_receipt" as const, turnId: "turn-ithaca", timing: { sendToFirstHostFrameMs: 5 } };

test("receipt parsing retains its kind on a schema refusal without accepting the bad timing", () => {
  expect(parseClientMessage(JSON.stringify(receipt))).toEqual({ ok: true, message: receipt });
  expect(parseClientMessage(JSON.stringify({ ...receipt, timing: { sendToFirstHostFrameMs: -1 } }))).toMatchObject({ ok: false, frameType: "client_turn_receipt" });
});

test("the small receipt byte cap does not restrict an ordinary chat message", () => {
  expect(parseClientMessage(" ".repeat(4096) + JSON.stringify(receipt))).toEqual({ ok: false,
    frameType: "client_turn_receipt", error: "Receipt exceeds 4096 bytes" });
  const chat = { type: "chat_message" as const, text: "Sail at dawn. ".repeat(400) };
  expect(parseClientMessage(JSON.stringify(chat))).toEqual({ ok: true, message: chat });
});

test("the final idle marker is an optional field on the existing status frame", () => {
  const idle = { type: "status" as const, status: "idle" as const, sessionId: "ithaca", turnId: "turn-ithaca" };
  expect(parseServerMessage(JSON.stringify(idle))).toEqual({ ok: true, message: idle });
  expect(parseServerMessage(JSON.stringify({ ...idle, hostTurnComplete: true }))).toEqual({ ok: true,
    message: { ...idle, hostTurnComplete: true } });
});
