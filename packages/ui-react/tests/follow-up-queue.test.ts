/**
 * Pending follow-ups on the client (#1002): the host's `session_queue`
 * reports become pills, a started follow-up enters the transcript once, at
 * the point its turn starts, and nothing is drawn twice when history replays.
 */
import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { sendReask } from "../src/components/chat/reask-send.js";

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

test("a message drawn as an ordinary send that the host queued moves out of the chat, and back in when it starts", () => {
  const { root, socket } = busy();
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds] });
  // The turn's result arrives, so the transcript stops streaming, but the
  // host still holds `winds` and has not handed it over yet.
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  const chat = root.stores.chat.getState();
  expect(chat.buffers[S]!.isStreaming).toBe(false);
  // The composer's ordinary path: the message and an empty reply for it.
  chat.addUserMessage(S, bag.text, "typed", undefined, { requestId: "req-bag" });
  chat.startAssistantMessage(S, undefined, "req-bag");
  socket.deliver({ type: "status", sessionId: S, status: "queued", requestId: "req-bag" });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });

  expect(users(root)).toEqual(["Chart the way home"]);
  expect(messages(root).map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(root.stores.chat.getState().buffers[S]!.isStreaming).toBe(false);
  expect(pending(root).map((f) => f.id)).toEqual(["fu-winds", "fu-bag"]);

  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...winds, turnId: "turn-2" } });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...bag, turnId: "turn-3" } });
  // In the order the agent received them, each once.
  expect(users(root)).toEqual(["Chart the way home", winds.text, bag.text]);
  expect(pending(root)).toEqual([]);
});

test("a re-asked answer sent behind a queued follow-up moves to the stack, then enters the chat once, in order", () => {
  const { root, socket } = busy();
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds] });
  const sent: Array<{ requestId?: string; text: string }> = [];
  sendReask(root.stores, S, "Yes: keep the bag shut", (msg) => { sent.push(msg as never); });
  const requestId = sent[0]!.requestId!;
  expect(requestId, "correlated like a composer send").toBeTruthy();
  socket.deliver({ type: "status", sessionId: S, status: "queued", requestId });
  const answer = { id: "fu-answer", requestId, text: "Yes: keep the bag shut", queuedAt: 5 };
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, answer] });
  expect(users(root)).toEqual(["Chart the way home"]);
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [answer], started: { ...winds, turnId: "turn-2" } });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...answer, turnId: "turn-3" } });
  expect(users(root)).toEqual(["Chart the way home", winds.text, "Yes: keep the bag shut"]);
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

test("a follow-up whose turn fails before naming itself still enters the chat above the failure", () => {
  const { root, socket } = busy();
  root.stores.followUp.getState().addLocal(S, { requestId: "req-bag", text: bag.text, source: "typed", queuedAt: 3 });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  // The session had gone idle, so it ran at once, and failed at start-up.
  socket.deliver({ type: "error", sessionId: S, turnId: "turn-2", requestId: "req-bag", code: "BACKEND_ERROR", message: "The runtime did not start." });
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

test("previews nobody will draw are released: a dropped entry's, and an accepted one's on a new connection", () => {
  const revoked: string[] = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  try {
    const { root, socket } = busy();
    const image = (name: string) => [{ previewUrl: `blob:ithaca/${name}`, mediaType: "image/png" }];
    const followUps = root.stores.followUp.getState();
    followUps.addLocal(S, { requestId: "req-winds", text: winds.text, source: "typed", attachments: image("chart"), queuedAt: 1 });
    followUps.addLocal(S, { requestId: "req-bag", text: bag.text, source: "typed", attachments: image("bag"), queuedAt: 2 });
    followUps.addLocal(S, { requestId: "req-oars", text: "Count the oars", source: "typed", attachments: image("oars"), queuedAt: 3 });
    socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
    socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], dropped: [{ id: "fu-winds", requestId: "req-winds", reason: "Cancelled by user" }] });
    expect(revoked).toEqual(["blob:ithaca/chart"]);
    // A new connection: `bag` was accepted, `oars` was never confirmed and is
    // still the composer's draft.
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { followUpQueue: true } });
    expect(revoked).toEqual(["blob:ithaca/chart", "blob:ithaca/bag"]);
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("another client's follow-up with files is read again from history once its turn ends", () => {
  const { root, socket } = busy();
  const resumes = () => socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === "session_resume");
  const shared = { id: "fu-log", requestId: "req-log", text: "", fileCount: 1, queuedAt: 3 };
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [shared] });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...shared, turnId: "turn-2" } });
  expect(resumes()).toEqual([]);
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  expect(resumes()).toEqual([{ type: "session_resume", sessionId: S }]);
  expect(root.stores.followUp.getState().pending[S]).toBeUndefined();
});

test("the history refresh waits until nothing else is queued in the session", () => {
  const { socket } = busy();
  const resumes = () => socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === "session_resume");
  const files = { id: "fu-log", requestId: "req-log", text: "", fileCount: 1, queuedAt: 3 };
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...files, turnId: "turn-2" } });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  // `bag` is about to start: a replay now could land over its live frames.
  expect(resumes()).toEqual([]);
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...bag, turnId: "turn-3" } });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-3", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  expect(resumes()).toEqual([{ type: "session_resume", sessionId: S }]);
});

test("a deferred refresh runs when the last pending entry is dropped instead of run", () => {
  const { socket } = busy();
  const resumes = () => socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === "session_resume");
  const files = { id: "fu-log", requestId: "req-log", text: "", fileCount: 1, queuedAt: 3 };
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...files, turnId: "turn-2" } });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  expect(resumes()).toEqual([]);
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], dropped: [{ id: "fu-bag", requestId: "req-bag", reason: "Its sender was signed out." }] });
  expect(resumes()).toEqual([{ type: "session_resume", sessionId: S }]);
});

test("a long text this client sent shows whole, though the host reports only its head", () => {
  const { root, socket } = busy();
  const whole = `Sing of the raft: ${"the timber, the sail, the stars. ".repeat(400)}`;
  root.stores.followUp.getState().addLocal(S, { requestId: "req-song", text: whole, source: "typed", queuedAt: 3 });
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [
    { id: "fu-song", requestId: "req-song", text: `${whole.slice(0, 7_900)}\n…[${whole.length - 7_900} chars elided]`, textTruncated: true, queuedAt: 3 },
  ] });
  expect(pending(root)).toEqual([expect.objectContaining({ id: "fu-song", text: whole, confirmed: true })]);
  expect(pending(root)[0]!).not.toHaveProperty("textTruncated");
});

test("each session whose started follow-up arrived incomplete reads its own history again", () => {
  const { root, socket } = busy();
  const S2 = "sess-scheria";
  socket.deliver({ type: "session_history", sessionId: S2, messages: [{ role: "user", content: "Plan the feast at Scheria", toolCalls: [] }] });
  const resumes = () => socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === "session_resume").map((f) => f.sessionId);
  const files = { id: "fu-log", requestId: "req-log", text: "", fileCount: 1, queuedAt: 3 };
  const long = { id: "fu-song", requestId: "req-song", text: "Sing of the raft\n…[190000 chars elided]", textTruncated: true, queuedAt: 4 };
  socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...files, turnId: "turn-2" } });
  socket.deliver({ type: "session_queue", sessionId: S2, followUps: [], started: { ...long, turnId: "turn-9" } });
  expect(root.stores.chat.getState().buffers[S2]!.messages.at(-2)!.content).toBe(long.text);
  socket.deliver({ type: "result", sessionId: S2, turnId: "turn-9", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  expect(resumes()).toEqual([S2, S]);
});
