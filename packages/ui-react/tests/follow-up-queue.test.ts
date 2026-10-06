/**
 * Pending follow-ups on the client (#1002): the host's `session_queue`
 * reports become pills, a started follow-up enters the transcript once, at
 * the point its turn starts, and nothing is drawn twice when history replays.
 */
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
}
const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); globalThis.WebSocket = realSocket; });

const S = "sess-ithaca";
const winds = { id: "fu-winds", requestId: "req-winds", text: "Ask Aeolus about the west wind", queuedAt: 1 };
const bag = { id: "fu-bag", requestId: "req-bag", text: "Keep the bag of winds shut", queuedAt: 2 };

/** A session with one answer streaming, as a busy session looks. */
function busy() {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const root = createBrainUiRoot({ storage: null, storagePrefix: "follow-up-test", config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(root);
  root.connection.connect();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, followUpQueue: true } });
  const chat = root.stores.chat.getState();
  chat.setActiveSession(S);
  socket.deliver({ type: "session_history", sessionId: S, messages: [{ role: "user", content: "Chart the way home", toolCalls: [] }] });
  socket.deliver({ type: "session_info", sessionId: S, isNew: false, turnId: "turn-1" });
  socket.deliver({ type: "text_delta", sessionId: S, turnId: "turn-1", text: "Plotting the course" });
  return { root, socket };
}
const messages = (root: BrainUiRoot) => root.stores.chat.getState().buffers[S]!.messages;
const pending = (root: BrainUiRoot) => root.stores.followUp.getState().pending[S] ?? [];
const users = (root: BrainUiRoot) => messages(root).filter((m) => m.role === "user").map((m) => m.content);

test("the host's report is the pending stack, and none of it is in the chat", () => {
  const { root, socket } = busy();
  expect(root.stores.connection.getState().followUpQueue).toBe(true);
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
  expect(pending(root).map((f) => f.text)).toEqual([winds.text, bag.text]);
  expect(pending(root).every((f) => f.confirmed)).toBe(true);
  expect(users(root)).toEqual(["Chart the way home"]);
});

test("a started follow-up leaves the stack and enters the chat once, after the turn it waited for", () => {
  const { root, socket } = busy();
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...winds, turnId: "turn-2" } });

  expect(pending(root).map((f) => f.id)).toEqual(["fu-bag"]);
  expect(messages(root).map((m) => [m.role, m.content])).toEqual([
    ["user", "Chart the way home"],
    ["assistant", "Plotting the course"],
    ["user", winds.text],
    ["assistant", ""],
  ]);
  expect(messages(root)[2]!.requestId).toBe("req-winds");
  expect(root.stores.followUp.getState().announcement?.text).toBe("Follow-up sent to the agent");

  // The turn's own frames land in the message opened for it, not in a second one.
  socket.deliver({ type: "session_info", sessionId: S, isNew: false, turnId: "turn-2", requestId: "req-winds" });
  socket.deliver({ type: "text_delta", sessionId: S, turnId: "turn-2", text: "The west wind holds" });
  expect(users(root)).toEqual(["Chart the way home", winds.text]);
  expect(messages(root).at(-1)!.content).toBe("The west wind holds");

  // A repeated report and a history replay that already holds it draw nothing twice.
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...winds, turnId: "turn-2" } });
  expect(users(root)).toEqual(["Chart the way home", winds.text]);
  socket.deliver({ type: "session_history", sessionId: S, messages: [
    { role: "user", content: "Chart the way home", toolCalls: [] },
    { role: "assistant", content: "Plotting the course", toolCalls: [] },
    { role: "user", content: winds.text, toolCalls: [] },
  ] });
  expect(users(root)).toEqual(["Chart the way home", winds.text]);
  expect(pending(root).map((f) => f.id)).toEqual(["fu-bag"]);
});

test("a message sent while busy shows at once, then becomes the host's entry without doubling", () => {
  const { root, socket } = busy();
  const followUps = root.stores.followUp.getState();
  followUps.addLocal(S, { requestId: "req-bag", text: bag.text, source: "typed", queuedAt: 3 });
  expect(pending(root)).toEqual([expect.objectContaining({ id: "local:req-bag", confirmed: false })]);
  expect(root.stores.followUp.getState().announcement?.text).toBe("Follow-up queued");
  socket.deliver({ type: "status", sessionId: S, status: "queued", requestId: "req-bag" });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag] });
  expect(pending(root)).toEqual([expect.objectContaining({ id: "fu-bag", confirmed: true })]);
  expect(users(root)).toEqual(["Chart the way home"]);
});

test("a refused follow-up was never pending", () => {
  const { root, socket } = busy();
  root.stores.followUp.getState().addLocal(S, { requestId: "req-bag", text: bag.text, source: "typed", queuedAt: 3 });
  socket.deliver({ type: "error", sessionId: S, code: "SESSION_QUEUE_FULL", requestId: "req-bag", message: "This session's queue is full." });
  expect(pending(root)).toEqual([]);
  expect(users(root)).toEqual(["Chart the way home"]);
});

test("a follow-up that ran at once because the session had just gone idle enters the chat when its turn starts", () => {
  const { root, socket } = busy();
  root.stores.followUp.getState().addLocal(S, { requestId: "req-bag", text: bag.text, source: "typed", queuedAt: 3 });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_info", sessionId: S, isNew: false, turnId: "turn-2", requestId: "req-bag" });
  expect(pending(root)).toEqual([]);
  expect(users(root)).toEqual(["Chart the way home", bag.text]);
});

test("a dropped follow-up leaves with its reason", () => {
  const { root, socket } = busy();
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], dropped: [
    { id: "fu-winds", requestId: "req-winds", reason: "Cancelled by user" },
    { id: "fu-bag", requestId: "req-bag", reason: "Cancelled by user" },
  ] });
  expect(pending(root)).toEqual([]);
  expect(root.stores.followUp.getState().announcement?.text).toBe("Follow-up dropped: Cancelled by user");
  expect(users(root)).toEqual(["Chart the way home"]);
});

test("a new connection clears the old stack and the host's reports rebuild it", () => {
  const { root, socket } = busy();
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
  // A hello opens every connection, so it is the reload's first frame.
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { followUpQueue: true } });
  expect(pending(root)).toEqual([]);
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag] });
  expect(pending(root).map((f) => f.id)).toEqual(["fu-bag"]);
});
