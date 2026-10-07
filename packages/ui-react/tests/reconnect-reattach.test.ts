/**
 * A reconnect in the middle of a running turn (#1013). The browser proof is
 * `connection-continuity-runtime.test.ts`; these pin the two rules it found
 * missing, one layer down:
 *
 * - The host greets every new connection with an unscoped `idle`, also while
 *   the session in view is still running beside another one. That greeting
 *   must not end the stream in view. The page reattaches instead, and the
 *   host's scoped answer to that resume decides.
 * - A history replay of a transcript already drawn keeps the messages it
 *   repeats (their ids, so React keeps their nodes, and their times), and a
 *   live answer it continues stays live until the host's status ends it.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
  close() { this.readyState = 3; }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" } as CloseEvent); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames() { return this.sent.map((raw) => JSON.parse(raw) as { type: string; sessionId?: string }); }
}
const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); globalThis.WebSocket = realSocket; });

const SIRENS = "Setting out: Sail past the Sirens.";
const history = (answer: string) => [
  { role: "user" as const, content: "Hold: Sail past the Sirens", toolCalls: [] },
  { role: "assistant" as const, content: answer, toolCalls: [] },
];

/** Session s1 in view, its turn streaming the opening of an answer. */
function running() {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(root);
  root.connection.connect();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  const chat = root.stores.chat.getState();
  chat.setActiveSession("s1");
  socket.deliver({ type: "session_history", sessionId: "s1", messages: history("").slice(0, 1) });
  root.stores.chat.getState().startAssistantMessage("s1");
  root.stores.chat.getState().appendText("s1", SIRENS);
  return { root, socket };
}
const buffer = (root: BrainUiRoot) => root.stores.chat.getState().buffers.s1!;

/** The socket closes under the page, and the page connects again. */
function reconnect(root: BrainUiRoot, socket: Socket): Socket {
  socket.drop();
  root.connection.reconnectNow();
  const next = Socket.instances.at(-1)!;
  expect(next, "a new socket").not.toBe(socket);
  next.open();
  return next;
}

describe("a reconnect while the turn in view runs", () => {
  test("the host's unscoped greeting does not end it; the page reattaches and the host's answer decides", () => {
    const { root, socket } = running();
    const before = buffer(root).messages.map((m) => m.id);
    const next = reconnect(root, socket);
    expect(next.frames().filter((f) => f.type === "session_resume"), "the page reattaches").toEqual([{ type: "session_resume", sessionId: "s1" }]);

    // Two sessions run on the host, so it greets without a snapshot.
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming, "the greeting is not this session's idle").toBe(true);

    // The host's answer to the resume: the history so far, then running.
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", detail: "Session in progress" });
    expect(buffer(root).isStreaming, "still running").toBe(true);
    expect(buffer(root).messages.map((m) => m.id), "the drawn messages are kept").toEqual(before);

    // The rest of the answer streams into the same message, and the turn ends.
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a turn that ended while the page was away is ended by the host's scoped idle", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(`${SIRENS} Landed.`) });
    next.deliver({ type: "status", sessionId: "s1", status: "idle", detail: "Session loaded" });
    expect(buffer(root).isStreaming).toBe(false);
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: `${SIRENS} Landed.`, isStreaming: false });
  });

  test("a turn that ended away, with a queued follow-up now running, ends the kept answer; the new turn's text is its own", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    // The answer in view belongs to turn-1, still streaming as far as the page knows.
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    // The host: turn-1 ended, the follow-up's user message, and turn-2 running.
    next.deliver({ type: "session_history", sessionId: "s1", messages: [
      ...history(SIRENS),
      { role: "assistant", content: "Rowing on. Landed.", toolCalls: [], turnId: "turn-1" },
      { role: "user", content: "Then bind me to the mast", toolCalls: [] },
    ] });
    expect(buffer(root).isStreaming, "a message after the answer ends it").toBe(false);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Bound." });
    const messages = buffer(root).messages;
    expect(messages.map((m) => m.content).slice(-3)).toEqual(["Rowing on. Landed.", "Then bind me to the mast", "Bound."]);
  });

  test("a kept answer whose turn the host reports replaced ends, though nothing follows it yet", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Rowing on.", toolCalls: [], turnId: "turn-1" }] });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    expect(buffer(root).isStreaming, "turn-1's answer is over").toBe(false);
  });

  test("a resume the host could not serve does not leave the stream open forever", () => {
    const { root, socket } = running();
    // An answer that knows its turn: a turnless load error is not drawn on it.
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Rowing on.");
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "Failed to load session", sessionId: "s1" });
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a history that stops before the answer being written keeps it, and the turn's end replays the whole", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    const before = buffer(root).messages.map((m) => m.id);
    // A backend that keeps an answer only once it ends: the history so far is the question.
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).messages.map((m) => m.id), "the answer on screen stays").toEqual(before);
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: SIRENS, isStreaming: true });
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
    expect(next.frames().filter((f) => f.type === "session_resume"), "the reattach, then the turn's end").toHaveLength(2);
  });

  test("a replay that names no turn keeps the turn the page knew, so a new turn still ends the answer", () => {
    const { root, socket } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.stores.chat.getState().startAssistantMessage("s1", "turn-1");
    root.stores.chat.getState().appendText("s1", "Bound.");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: [...history(SIRENS), { role: "assistant", content: "Bound.", toolCalls: [] }] });
    expect(buffer(root).messages.at(-1)).toMatchObject({ turnId: "turn-1", isStreaming: true });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking", turnId: "turn-2" });
    next.deliver({ type: "text_delta", sessionId: "s1", turnId: "turn-2", text: "Row on." });
    expect(buffer(root).messages.map((m) => [m.content, m.turnId ?? null]).slice(-2)).toEqual([["Bound.", "turn-1"], ["Row on.", "turn-2"]]);
  });

  test("a replay in chunks that splits just before the answer draws it once", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    const before = buffer(root).messages.map((m) => m.id);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "session_history", sessionId: "s1", append: true, messages: history(SIRENS).slice(1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).messages.map((m) => m.id), "one answer, the one on screen").toEqual(before);
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "text_delta", sessionId: "s1", text: " Landed." });
    expect(buffer(root).messages.map((m) => m.content)).toEqual(["Hold: Sail past the Sirens", `${SIRENS} Landed.`]);
  });

  test("a first chunk that stops early still leaves the turn's end to replay the whole", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    // A first chunk that ends before the question on screen, then the rest.
    next.deliver({ type: "session_history", sessionId: "s1", messages: [] });
    next.deliver({ type: "session_history", sessionId: "s1", append: true, messages: history(SIRENS).slice(0, 1) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    expect(buffer(root).isStreaming).toBe(true);
    next.deliver({ type: "result", sessionId: "s1", outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    expect(next.frames().filter((f) => f.type === "session_resume"), "the reattach, then the turn's end").toHaveLength(2);
  });

  test("a history with the same text but less of the answer's tools keeps the tool on screen", () => {
    const { root, socket } = running();
    root.stores.chat.getState().startToolCall("s1", "wax-1", "Bash");
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    expect(buffer(root).messages.at(-1)!.toolCalls.map((t) => t.id)).toEqual(["wax-1"]);
    expect(buffer(root).isStreaming).toBe(true);
  });

  test("a page ahead of the host's stored answer keeps what it has drawn", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history("Setting out:") });
    expect(buffer(root).messages.at(-1)).toMatchObject({ content: SIRENS, isStreaming: true });
  });

  test("a refusal of another request while reattaching is not the resume failing", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    next.deliver({ type: "error", code: "ATTACHMENT_REJECTED", message: "Too large", sessionId: "s1", requestId: "req-1" });
    expect(buffer(root).isStreaming, "the answer still runs").toBe(true);
    next.deliver({ type: "status", status: "idle", detail: "Connected to Brain" });
    expect(buffer(root).isStreaming, "and the greeting is still not its idle").toBe(true);
  });

  test("once the host has answered, a later unscoped idle is the session in view's again", () => {
    const { root, socket } = running();
    const next = reconnect(root, socket);
    next.deliver({ type: "session_history", sessionId: "s1", messages: history(SIRENS) });
    next.deliver({ type: "status", sessionId: "s1", status: "thinking" });
    next.deliver({ type: "status", status: "idle" });
    expect(buffer(root).isStreaming).toBe(false);
  });
});

describe("a history replay of a transcript already drawn", () => {
  test("keeps the ids and times of the messages it repeats, and replaces the ones it changes", () => {
    const { root } = running();
    const chat = root.stores.chat.getState();
    chat.finishAssistantMessage("s1");
    const [user, answer] = buffer(root).messages;
    root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Hold: Sail past the Sirens", toolCalls: [] },
      { role: "assistant", content: "Rowed past Scylla instead.", toolCalls: [] },
    ] });
    const [replayedUser, replayedAnswer] = buffer(root).messages;
    expect(replayedUser).toMatchObject({ id: user!.id, timestamp: user!.timestamp });
    expect(replayedAnswer!.id, "a different answer is a different message").not.toBe(answer!.id);
    expect(buffer(root).isStreaming).toBe(false);
  });

  test("a tool-only answer replaced by another request's is a different message, though neither has text", () => {
    const { root } = running();
    const chat = root.stores.chat.getState();
    chat.finishAssistantMessage("s1");
    const ask = (id: string) => ({ id, name: "mcp__brain-ui__ask_user_rank", input: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }] } });
    const replay = (id: string, turnId: string) => root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: [
      { role: "user", content: "Hold: Sail past the Sirens", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [ask(id)], parts: [{ kind: "tool", toolIndex: 0 }], turnId } as never,
    ] });
    replay("rank-1", "turn-1");
    const first = buffer(root).messages[1]!.id;
    replay("rank-1", "turn-1");
    expect(buffer(root).messages[1]!.id, "the same request is the same message").toBe(first);
    replay("rank-2", "turn-1");
    expect(buffer(root).messages[1]!.id, "another request is another message").not.toBe(first);
    const second = buffer(root).messages[1]!.id;
    replay("rank-2", "turn-2");
    expect(buffer(root).messages[1]!.id, "another turn is another message").not.toBe(second);
  });

  test("a replay of a session that was not streaming does not start one", () => {
    const { root } = running();
    root.stores.chat.getState().finishAssistantMessage("s1");
    root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages: history(`${SIRENS} Landed.`) });
    expect(buffer(root).isStreaming).toBe(false);
    expect(buffer(root).messages.at(-1)!.isStreaming).toBe(false);
  });
});
