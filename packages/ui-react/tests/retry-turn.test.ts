import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(raw); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 } as CloseEvent); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames() { return this.sent.map(raw => JSON.parse(raw)); }
}
const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); globalThis.WebSocket = realSocket; });

function setup(storage: Storage | null = null) {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const root = createBrainUiRoot({ storage, storagePrefix: "retry-test", config: { backendUrl: "https://ithaca-harbour.example" } }); roots.push(root);
  root.connection.connect(); const socket = Socket.instances.at(-1)!; socket.open();
  root.stores.chat.getState().setActiveSession("s1");
  return { root, socket };
}
function failed(root: BrainUiRoot) {
  root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
    { role: "user", content: "Original", attachmentCount: 2, toolCalls: [] },
    { role: "assistant", content: "Partial", toolCalls: [], retryOfTurnId: "failed-turn", failure: { errorClass: "server_error", message: "Failed" } },
  ] });
  root.connection.handleServerMessage({ type: "status", sessionId: "s1", status: "idle" });
}

test("double tap sends one retained-request handle and acceptance appends a distinct turn", () => {
  const { root, socket } = setup(); failed(root);
  expect(root.connection.retryTurn("failed-turn")).toBe("sent");
  expect(root.connection.retryTurn("failed-turn")).toBe("pending");
  const sent = socket.frames().filter(f => f.type === "retry_turn");
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("text");
  socket.deliver({ type: "retry_receipt", sessionId: "s1", requestId: sent[0].requestId, state: "accepted", text: "Original", attachmentCount: 2 });
  const messages = root.stores.chat.getState().buffers.s1.messages;
  expect(messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(messages[2]).toMatchObject({ content: "Original", attachmentCount: 2 });
  expect(messages[1].failure).toBeDefined();
  expect(messages[3].isStreaming).toBe(true);
});

test("a known future reset refuses a retry without sending, then admits the original handle at expiry", () => {
  const originalNow = Date.now;
  let now = Date.UTC(2026, 3, 11, 12);
  Date.now = () => now;
  try {
    const { root, socket } = setup();
    root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Original", attachmentCount: 2, toolCalls: [] },
      { role: "assistant", content: "Partial", toolCalls: [], retryOfTurnId: "failed-turn",
        failure: { errorClass: "rate_limit", message: "Reported limit", attempts: 2, resetsAt: now + 3250 } },
    ] });
    root.connection.handleServerMessage({ type: "status", sessionId: "s1", status: "idle" });
    expect(root.stores.chat.getState().buffers.s1.messages.at(-1)!.failure?.resetsAt).toBe(now + 3250);
    expect(root.connection.retryTurn("failed-turn")).toBe("refused");
    expect(socket.frames().filter(frame => frame.type === "retry_turn")).toHaveLength(0);
    now += 3250;
    expect(root.connection.retryTurn("failed-turn")).toBe("sent");
    expect(root.connection.retryTurn("failed-turn")).toBe("pending");
    expect(socket.frames().filter(frame => frame.type === "retry_turn")).toEqual([
      expect.objectContaining({ failedTurnId: "failed-turn" }),
    ]);
  } finally {
    Date.now = originalNow;
  }
});

test("a historical card and an offline send cannot start a retry; an explicit refusal restores the action", () => {
  const { root, socket } = setup(); failed(root);
  root.stores.chat.getState().addUserMessage("s1", "Later");
  expect(root.connection.retryTurn("failed-turn")).toBe("refused");
  expect(socket.frames().filter(f => f.type === "retry_turn")).toHaveLength(0);
  failed(root); root.stores.connection.getState().setWsStatus("disconnected");
  expect(root.connection.retryTurn("failed-turn")).toBe("refused");
  expect(root.stores.chat.getState().turnRetries.s1.state).toBe("refused");
  root.stores.connection.getState().setWsStatus("connected");
  expect(root.connection.retryTurn("failed-turn")).toBe("sent");
  const sent = socket.frames().filter(f => f.type === "retry_turn");
  socket.deliver({ type: "retry_receipt", sessionId: "s1", requestId: sent[0].requestId, state: "refused", message: "Server busy" });
  expect(root.stores.chat.getState().turnRetries.s1).toMatchObject({ state: "refused", message: "Server busy" });
  expect(root.connection.retryTurn("failed-turn")).toBe("sent");
});

test("reload with an unacknowledged send queries delivery and cannot blindly resend", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } as Storage;
  const a = setup(storage); failed(a.root);
  a.root.connection.retryTurn("failed-turn");
  const original = a.socket.frames().find(f => f.type === "retry_turn");
  a.root.dispose();
  const b = setup(storage); failed(b.root);
  expect(b.root.stores.chat.getState().turnRetries.s1.state).toBe("unknown");
  expect(b.root.connection.retryTurn("failed-turn")).toBe("pending");
  expect(b.socket.frames().filter(f => f.type === "retry_turn")).toHaveLength(0);
  expect(b.socket.frames().filter(f => f.type === "retry_status")).toEqual([{ type: "retry_status", sessionId: "s1", requestId: original.requestId }]);
  b.socket.deliver({ type: "retry_receipt", sessionId: "s1", requestId: original.requestId, state: "accepted" });
  expect(b.root.stores.chat.getState().turnRetries.s1).toBeUndefined();
  // Selecting s1 read its history (#1328); the recovered receipt heals from history once more.
  expect(b.socket.frames().filter(f => f.type === "session_resume")).toEqual([{ type: "session_resume", sessionId: "s1" }, { type: "session_resume", sessionId: "s1" }]);
  expect([...data.values()].join("\n")).not.toContain("Original");
});
