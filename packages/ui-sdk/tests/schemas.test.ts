import { describe, expect, test } from "bun:test";

import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_PROMPT_CHARS,
  clientMessageSchema,
  parseClientMessage,
} from "../src/schemas";
import { MAX_IMAGE_BYTES } from "../src/protocol";

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
      { type: "mask_response", requestId: "r1", maskPng: "iVBORw0KGgo=" },
      { type: "mask_error", requestId: "r1", code: "cancelled", message: "closed" },
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
      { type: "mask_response", requestId: "r" }, // no mask
      { type: "mask_error", requestId: "r", code: "nope", message: "m" }, // unknown code
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

describe("additive-protocol + limit invariants", () => {
  test("unknown keys are PRESERVED, not stripped (additive contract)", () => {
    const parsed = clientMessageSchema.parse({
      type: "cancel",
      sessionId: "s1",
      futureField: "keep-me",
    });
    expect((parsed as Record<string, unknown>).futureField).toBe("keep-me");
  });

  test("aggregate decoded attachment bytes are capped at the boundary", () => {
    // 4 images just under the per-image cap decode to ~8MB > the 6MB total.
    // Length must be a multiple of 4 to be well-formed base64.
    const raw = Math.floor((MAX_IMAGE_BYTES * 4) / 3) - 4;
    const big = "A".repeat(raw - (raw % 4));
    const four = Array.from({ length: 4 }, () => ({ data: big, mediaType: "image/png" }));
    expect(
      clientMessageSchema.safeParse({ type: "chat_message", text: "x", attachments: four }).success
    ).toBe(false);
    // One image of the same size is fine (under both caps).
    expect(
      clientMessageSchema.safeParse({
        type: "chat_message",
        text: "x",
        attachments: [four[0]],
      }).success
    ).toBe(true);
  });

  test("ask-user record cardinality is bounded", () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < 500; i++) answers[`q${i}`] = "a";
    expect(
      clientMessageSchema.safeParse({ type: "ask_user_response", requestId: "r", answers }).success
    ).toBe(false);
  });

  test("every interactive reply accepts a turnId echo", () => {
    const replies = [
      { type: "tool_approval", toolUseId: "t", turnId: "turn-1" },
      { type: "tool_denial", toolUseId: "t", message: "no", turnId: "turn-1" },
      { type: "ask_user_response", requestId: "r", answers: { q: "a" }, turnId: "turn-1" },
      { type: "ask_user_cancel", requestId: "r", turnId: "turn-1" },
      {
        type: "location_response",
        requestId: "r",
        coords: { latitude: 1, longitude: 2, accuracy: 3 },
        timestamp: 1,
        turnId: "turn-1",
      },
      { type: "location_error", requestId: "r", code: 1, message: "m", turnId: "turn-1" },
    ];
    for (const r of replies) {
      const parsed = clientMessageSchema.safeParse(r);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect((parsed.data as { turnId?: string }).turnId).toBe("turn-1");
      }
    }
  });

  test("oversized binary frames are rejected on raw byte length", () => {
    const buf = Buffer.alloc(MAX_CLIENT_FRAME_BYTES + 1, 0x20);
    const res = parseClientMessage(buf);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bytes");
  });
});

describe("mask frames", () => {
  test("a mask larger than the image budget is rejected at the boundary", () => {
    // The socket cap is 12MB, but a mask is flat colour and compresses hard:
    // anything approaching the per-image ceiling is not a mask.
    const huge = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64);
    const result = clientMessageSchema.safeParse({
      type: "mask_response",
      requestId: "r1",
      maskPng: huge,
    });
    expect(result.success).toBe(false);
  });

  test("a plausible mask passes", () => {
    const png = Buffer.alloc(4096, 7).toString("base64");
    expect(
      clientMessageSchema.safeParse({ type: "mask_response", requestId: "r1", maskPng: png }).success
    ).toBe(true);
  });
});
