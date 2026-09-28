/**
 * `source` on `chat_message` and on replayed user messages (#549) is additive
 * in both directions: a peer that does not send it is read as `typed`, a
 * peer that does not know it ignores it, and a value this build does not know
 * costs neither the message nor the history it rides in.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { parseClientMessage, parseServerMessage } from "../src/schemas.js";

function client(frame: unknown) {
  return parseClientMessage(JSON.stringify(frame));
}

function history(message: Record<string, unknown>) {
  return parseServerMessage(
    JSON.stringify({ type: "session_history", sessionId: "s1", messages: [message] })
  );
}

describe("chat_message source", () => {
  test("a client that omits it sends the same message as before", () => {
    const result = client({ type: "chat_message", text: "hi" });
    expect(result).toEqual({ ok: true, message: { type: "chat_message", text: "hi" } });
  });

  test("a known source is carried", () => {
    const result = client({ type: "chat_message", text: "hi", source: "voice-dictate" });
    expect(result.ok && result.message.type === "chat_message" && result.message.source).toBe(
      "voice-dictate"
    );
  });

  test("a source this build does not know reads as absent, and the message still runs", () => {
    for (const source of ["voice-telepathy", 7, null]) {
      const result = client({ type: "chat_message", text: "hi", source });
      expect(result.ok).toBe(true);
      if (result.ok && result.message.type === "chat_message") {
        expect(result.message.text).toBe("hi");
        expect(result.message.source).toBeUndefined();
      }
    }
  });
});

describe("session_history source", () => {
  test("a replayed user message carries its source", () => {
    const result = history({ role: "user", content: "hi", toolCalls: [], source: "voice-dictate" });
    expect(result.ok && result.message.type === "session_history" && result.message.messages[0]!.source).toBe(
      "voice-dictate"
    );
  });

  test("a source this build does not know drops the field, never the history", () => {
    const result = history({ role: "user", content: "hi", toolCalls: [], source: "voice-telepathy" });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "session_history") {
      expect(result.message.messages[0]!.content).toBe("hi");
      expect(result.message.messages[0]!.source).toBeUndefined();
    }
  });

  test("a client whose history schema predates the field accepts the frame", () => {
    // The history message shape as it was before `source` existed: an older
    // client validates with this, and must neither reject nor choke on it.
    const olderHistoryMessage = z.looseObject({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      toolCalls: z.array(z.unknown()),
      attachmentCount: z.number().optional(),
    });
    const parsed = olderHistoryMessage.safeParse({
      role: "user",
      content: "hi",
      toolCalls: [],
      source: "voice-dictate",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.content).toBe("hi");
  });
});
