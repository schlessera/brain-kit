import { describe, test, expect, beforeEach } from "bun:test";
import { sendSessionHistory } from "../src/ws/history";
import { resetClientsForTests, type WSContext } from "../src/ws/clients";
import { MAX_WS_MESSAGE_BYTES } from "../src/ws/shrink";
import type { SessionHistoryMessage, ServerSessionHistory } from "@schlessera/brain-ui-sdk/protocol";

function fakeSocket() {
  const sent: string[] = [];
  const ws: WSContext & { sent: string[] } = {
    sent,
    send(data) {
      sent.push(data);
    },
  };
  return ws;
}

function frames(ws: { sent: string[] }): ServerSessionHistory[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerSessionHistory);
}

function userMsg(content: string): SessionHistoryMessage {
  return { role: "user", content, toolCalls: [] };
}

beforeEach(() => {
  resetClientsForTests();
});

describe("sendSessionHistory chunking", () => {
  test("small history is one replacing frame (no append)", () => {
    const ws = fakeSocket();
    const history = [userMsg("hi"), userMsg("there")];
    sendSessionHistory(ws, "sess-1", history);

    const f = frames(ws);
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("session_history");
    expect(f[0].sessionId).toBe("sess-1");
    expect(f[0].append).toBeUndefined();
    expect(f[0].messages).toHaveLength(2);
  });

  test("empty history still emits one replacing frame so the client settles", () => {
    const ws = fakeSocket();
    sendSessionHistory(ws, "sess-empty", []);
    const f = frames(ws);
    expect(f).toHaveLength(1);
    expect(f[0].sessionId).toBe("sess-empty");
    expect(f[0].append).toBeUndefined();
    expect(f[0].messages).toHaveLength(0);
  });

  test("a large history splits into replace + append chunks that reconstruct fully", () => {
    const ws = fakeSocket();
    // ~40 messages of ~50KB each ⇒ well past a single 400KB chunk.
    const history = Array.from({ length: 40 }, (_, i) =>
      userMsg(`msg-${i}-` + "x".repeat(50_000))
    );
    sendSessionHistory(ws, "sess-big", history);

    const f = frames(ws);
    expect(f.length).toBeGreaterThan(1);
    // Exactly one replacing frame, and it is the first.
    expect(f[0].append).toBeUndefined();
    expect(f.slice(1).every((frame) => frame.append === true)).toBe(true);
    // Every frame carries the sessionId so the client can demux the load.
    expect(f.every((frame) => frame.sessionId === "sess-big")).toBe(true);

    // Every frame stays under the per-message cap.
    for (const s of ws.sent) {
      expect(s.length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    }

    // Concatenating all chunks reconstructs the full transcript in order.
    const flat = f.flatMap((frame) => frame.messages);
    expect(flat).toHaveLength(history.length);
    expect(flat[0].content.startsWith("msg-0-")).toBe(true);
    expect(flat[flat.length - 1].content.startsWith("msg-39-")).toBe(true);
  });

  test("a single oversized message is bounded and still shipped as its own chunk", () => {
    const ws = fakeSocket();
    const history = [userMsg("y".repeat(5_000_000))];
    sendSessionHistory(ws, "sess-huge", history);

    for (const s of ws.sent) {
      expect(s.length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    }
    const flat = frames(ws).flatMap((frame) => frame.messages);
    expect(flat).toHaveLength(1);
    expect(flat[0].content).toContain("chars elided");
  });
});
