import { describe, expect, test } from "bun:test";

import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_PROMPT_CHARS,
  clientMessageSchema,
  parseClientMessage,
} from "../src/schemas";

describe("clientMessageSchema", () => {
  test("accepts every legitimate frame kind", () => {
    const frames = [
      { type: "chat_message", text: "hi" },
      { type: "chat_message", text: "", sessionId: "s1", providerId: "claude" },
      {
        type: "chat_message",
        text: "look",
        attachments: [{ data: "aGk=", mediaType: "image/png" }],
      },
      { type: "tool_approval", toolUseId: "t1" },
      { type: "tool_approval", toolUseId: "t1", updatedInput: { a: 1 }, turnId: "turn-1" },
      { type: "tool_denial", toolUseId: "t1", message: "no" },
      { type: "cancel" },
      { type: "cancel", sessionId: "s1" },
      { type: "session_resume", sessionId: "s1" },
      { type: "ask_user_response", requestId: "r1", answers: { Q: "A" } },
      { type: "ask_user_cancel", requestId: "r1" },
      {
        type: "location_response",
        requestId: "r1",
        coords: { latitude: 1, longitude: 2, accuracy: 3 },
        timestamp: 123,
      },
      { type: "location_error", requestId: "r1", code: 1, message: "denied" },
    ];
    for (const f of frames) {
      expect(clientMessageSchema.safeParse(f).success).toBe(true);
    }
  });

  test("tolerates unknown keys (additive protocol), rejects unknown types", () => {
    expect(
      clientMessageSchema.safeParse({ type: "chat_message", text: "hi", futureField: 1 }).success
    ).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "future_frame" }).success).toBe(false);
  });

  test("rejects malformed frames", () => {
    const bad = [
      { type: "chat_message" }, // no text
      { type: "chat_message", text: "x".repeat(MAX_PROMPT_CHARS + 1) },
      { type: "chat_message", text: "x", attachments: [{ data: "aGk=", mediaType: "image/svg+xml" }] },
      { type: "tool_approval" }, // no toolUseId
      { type: "session_resume" }, // no sessionId
      { type: "session_resume", sessionId: "" },
      { type: "location_error", requestId: "r", code: 9, message: "m" },
      { type: "location_response", requestId: "r", coords: { latitude: "x" }, timestamp: 1 },
    ];
    for (const f of bad) {
      expect(clientMessageSchema.safeParse(f).success).toBe(false);
    }
  });
});

describe("parseClientMessage", () => {
  test("parses a valid JSON string frame", () => {
    const res = parseClientMessage(JSON.stringify({ type: "cancel" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.type).toBe("cancel");
  });

  test("rejects non-JSON, invalid frames, and oversized frames without throwing", () => {
    expect(parseClientMessage("{nope").ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "nope" })).ok).toBe(false);
    const huge = JSON.stringify({
      type: "chat_message",
      text: "x",
      pad: "y".repeat(MAX_CLIENT_FRAME_BYTES),
    });
    const res = parseClientMessage(huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bytes");
  });

  test("accepts Buffer input", () => {
    const res = parseClientMessage(Buffer.from(JSON.stringify({ type: "cancel" })));
    expect(res.ok).toBe(true);
  });
});
