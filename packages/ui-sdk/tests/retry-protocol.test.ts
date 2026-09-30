import { expect, test } from "bun:test";
import { parseClientMessage, parseServerMessage } from "../src/schemas.js";

test("manual retry and delivery queries round-trip without exposing original images", () => {
  for (const frame of [
    { type: "retry_turn", sessionId: "s1", failedTurnId: "turn-one", requestId: "retry-one" },
    { type: "retry_status", sessionId: "s1", requestId: "retry-one" },
  ] as const) expect(parseClientMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
  for (const state of ["accepted", "refused", "unknown"] as const) {
    const frame = { type: "retry_receipt", sessionId: "s1", requestId: "retry-one", state } as const;
    expect(parseServerMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
  }
  expect(parseClientMessage(JSON.stringify({ type: "retry_turn", sessionId: "s1", requestId: "one" })).ok).toBe(false);
  expect(parseClientMessage(JSON.stringify({ type: "retry_status", sessionId: "", requestId: "one" })).ok).toBe(false);
  expect(parseServerMessage(JSON.stringify({ type: "retry_receipt", requestId: "one", state: "queued" })).ok).toBe(false);
});

test("an unreadable optional retry handle cannot discard an otherwise readable failure", () => {
  const frame = { type: "result", sessionId: "s1", isError: true, numTurns: 1, durationMs: 1, retryOfTurnId: 42,
    failure: { errorClass: "server_error", message: "Provider failed" } };
  const result = parseServerMessage(JSON.stringify(frame));
  expect(result.ok).toBe(true);
  if (result.ok && result.message.type === "result") {
    expect(result.message.retryOfTurnId).toBeUndefined();
    expect(result.message.failure).toEqual(frame.failure);
  }
});
