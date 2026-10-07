import { describe, test, expect } from "bun:test";
import { sendSessionHistory } from "../src/ws/history";
import { type WSContext } from "../src/ws/clients";
// Independent default frame budget, so the cap cannot drift with its oracle.
const FRAME_BUDGET_BYTES = 512_000;
import type { SessionHistoryMessage, ServerSessionHistory } from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";

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
  return ws.sent.map((s) => {
    const parsed = parseServerMessage(s);
    expect(parsed.ok).toBe(true);
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    return JSON.parse(s) as ServerSessionHistory;
  });
}

function userMsg(content: string): SessionHistoryMessage {
  return { role: "user", content, toolCalls: [] };
}

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
      expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
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
      expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    }
    const flat = frames(ws).flatMap((frame) => frame.messages);
    expect(flat).toHaveLength(1);
    expect(flat[0].content).toContain("chars elided");
  });

  test("large tool histories remain schema-valid with no dangling chronological references", () => {
    const ws = fakeSocket();
    const history: SessionHistoryMessage[] = [{
      role: "assistant", content: "Answer", toolCalls: Array.from({ length: 300 }, (_, i) => ({
        id: `tool-${i}`, name: "Read", input: {}, output: "x".repeat(2000),
      })),
      // Include a reference beyond the retained prefix near the beginning.
      parts: [{ kind: "tool", toolIndex: 299 }, { kind: "tool", toolIndex: 0 }, { kind: "text", text: "Answer" }],
    }];
    sendSessionHistory(ws, "sess-tools", history);
    const [message] = frames(ws).flatMap((frame) => frame.messages);
    expect(message.toolCalls.length).toBeLessThan(300);
    expect(message.content).toContain("tool calls elided");
    for (const part of message.parts ?? []) {
      if (part.kind === "tool") expect(message.toolCalls[part.toolIndex]?.id).toBe(`tool-${part.toolIndex}`);
    }
    expect(message.parts).toContainEqual({ kind: "tool", toolIndex: 0 });
    expect(history[0].toolCalls).toHaveLength(300); // never mutate stored history
  });

  test("UTF-8 histories obey byte caps and preserve every small message", () => {
    const ws = fakeSocket();
    const history = Array.from({ length: 20 }, (_, i) => userMsg(`${i}:` + "漢😀".repeat(20_000)));
    sendSessionHistory(ws, "sess-unicode", history);
    const flat = frames(ws).flatMap((frame) => frame.messages);
    expect(flat).toEqual(history);
    expect(ws.sent.length).toBeGreaterThan(1);
  });

  test("large nested tool input records are bounded without changing their schema", () => {
    const ws = fakeSocket();
    const input = { nested: Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`field-${i}`, "value".repeat(10)])) };
    sendSessionHistory(ws, "sess-input", [{
      role: "assistant", content: "", toolCalls: [{ id: "tool-1", name: "Read", input }],
    }]);
    const [message] = frames(ws).flatMap((frame) => frame.messages);
    expect(message.toolCalls[0].id).toBe("tool-1");
    expect(message.toolCalls[0].input).toHaveProperty("nested");
  });

  test("a near-cap message plus its wrapper does not trigger a second history truncation", () => {
    const ws = fakeSocket();
    const history = Array.from({ length: 3 }, (_, i) => userMsg(`${i}:` + "x".repeat(511_950)));
    sendSessionHistory(ws, "sess-boundary", history);
    const flat = frames(ws).flatMap((frame) => frame.messages);
    expect(flat).toHaveLength(3);
    flat.forEach((message, i) => expect(message.content.startsWith(`${i}:`)).toBe(true));
  });
});
