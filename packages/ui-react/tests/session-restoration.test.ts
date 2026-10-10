/**
 * Restoring the selected session after a reload (#1328), on the real root,
 * stores and connection over a scripted socket. A reload keeps the selected
 * session's id and none of its transcript; until the host's history for it
 * arrives, nothing may be sent into it, the request for that history is
 * retried rather than fired once, and a request nobody answers ends in a
 * visible failure. The mounted page is proven in Chromium by
 * `browser/session-restoration.offline.tsx`.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { RESTORE_DEADLINE_MS } from "../src/connection.js";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { restorationOf } from "../src/stores/chat-state.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { Socket.instances.push(this); }
  send(raw: string) { if (this.readyState !== 1) throw new Error("send on a socket that is not open"); this.sent.push(raw); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" } as CloseEvent); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown> & { type: string }).filter((f) => f.type === type); }
}

const realSocket = globalThis.WebSocket;
const roots: BrainUiRoot[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose();
  globalThis.WebSocket = realSocket;
  Socket.instances = [];
  vi.useRealTimers();
});

const OGYGIA = "ogygia-raft";
const HISTORY = [
  { role: "user" as const, content: "Is the raft lashed for the crossing?", toolCalls: [] },
  { role: "assistant" as const, content: "Calypso checked every knot at dawn.", toolCalls: [] },
];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } as Storage;
}

/**
 * A page reloaded while OGYGIA was selected: a first root selects it and is
 * gone; a second root over the same storage starts with only its id.
 */
function reloaded(): BrainUiRoot {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const storage = memoryStorage();
  const before = createBrainUiRoot({ storage, storagePrefix: "odysseus", config: { backendUrl: "https://ithaca-harbour.example" } });
  before.stores.chat.getState().setActiveSession(OGYGIA);
  before.dispose();
  const root = createBrainUiRoot({ storage, storagePrefix: "odysseus", config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(root);
  return root;
}

function connect(root: BrainUiRoot): Socket {
  root.connection.connect();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  return socket;
}

/** What the composer sends for a typed message into the session in view. */
function typedMessage(root: BrainUiRoot, text: string): boolean {
  const sessionId = root.stores.chat.getState().activeSessionId;
  return root.connection.send({ type: "chat_message", text, ...(sessionId ? { sessionId } : {}), source: "typed" });
}

describe("a reload that kept the selected session's id", () => {
  test("the restored id has no confirmed history, and nothing is sent into it until its history arrives", () => {
    const root = reloaded();
    expect(root.stores.chat.getState().activeSessionId, "the reload kept the selected id").toBe(OGYGIA);
    const socket = connect(root);
    // The host greets every connection with an unscoped idle.
    socket.deliver({ type: "status", status: "idle" });
    expect(typedMessage(root, "Sail tonight?"), "a message into the unseen session is refused").toBe(false);
    expect(socket.frames("chat_message")).toEqual([]);
    expect(restorationOf(root.stores.chat.getState())).toEqual({ sessionId: OGYGIA, phase: "restoring" });
    expect(socket.frames("session_resume"), "one request for the selected session's history, not one per greeting").toEqual([{ type: "session_resume", sessionId: OGYGIA }]);

    socket.deliver({ type: "session_info", sessionId: OGYGIA, isNew: false });
    socket.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    socket.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    expect(restorationOf(root.stores.chat.getState())).toBeNull();
    expect(root.stores.chat.getState().buffers[OGYGIA]!.messages.map((m) => m.content)).toEqual(HISTORY.map((m) => m.content));
    expect(socket.frames("chat_message"), "recovery sends nothing by itself").toEqual([]);
    expect(typedMessage(root, "Sail tonight?")).toBe(true);
    expect(socket.frames("chat_message")).toEqual([{ type: "chat_message", text: "Sail tonight?", sessionId: OGYGIA, source: "typed" }]);
  });

  test("an empty buffer is not history; a matching empty history is", () => {
    const root = reloaded();
    const socket = connect(root);
    root.stores.chat.getState().setActiveSession(OGYGIA);
    expect(root.stores.chat.getState().buffers[OGYGIA], "selecting opened an empty buffer").toBeDefined();
    expect(typedMessage(root, "Start the log."), "an empty initial buffer takes no message").toBe(false);
    expect(restorationOf(root.stores.chat.getState())?.phase, "an empty initial buffer is not confirmed").toBe("restoring");
    socket.deliver({ type: "session_history", sessionId: "aeaea-circe", messages: HISTORY });
    expect(restorationOf(root.stores.chat.getState())?.phase, "another session's history confirms nothing here").toBe("restoring");
    socket.deliver({ type: "session_history", sessionId: OGYGIA, messages: [] });
    expect(restorationOf(root.stores.chat.getState()), "a matching empty history is confirmed").toBeNull();
    expect(typedMessage(root, "Start the log.")).toBe(true);
  });

  test("a request the socket never sent is asked on the next connection", () => {
    const root = reloaded();
    root.connection.connect();
    const first = Socket.instances.at(-1)!;
    // The socket fails before it opens: no request could leave.
    first.drop();
    expect(first.sent).toEqual([]);
    root.connection.reconnectNow();
    const next = Socket.instances.at(-1)!;
    expect(next).not.toBe(first);
    next.open();
    expect(next.frames("session_resume")).toEqual([{ type: "session_resume", sessionId: OGYGIA }]);
  });

  test("a request the host never answered is asked again on the next connection, and on the session's next idle", () => {
    const root = reloaded();
    const socket = connect(root);
    expect(socket.frames("session_resume")).toHaveLength(1);
    socket.drop();
    root.connection.reconnectNow();
    const next = Socket.instances.at(-1)!;
    next.open();
    expect(next.frames("session_resume"), "the swallowed request is asked again").toEqual([{ type: "session_resume", sessionId: OGYGIA }]);
    // A status for the session with no history before it: the reply was lost.
    next.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    expect(next.frames("session_resume"), "the session's idle asks once more").toHaveLength(2);
    next.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    expect(next.frames("session_resume"), "once per attempt, never a loop").toHaveLength(2);
    next.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    expect(restorationOf(root.stores.chat.getState())).toBeNull();
  });

  test("an unanswered request fails visibly at the deadline; Retry asks again, read-only", () => {
    vi.useFakeTimers();
    const root = reloaded();
    const socket = connect(root);
    // The host's greeting: an open socket that says nothing is abandoned.
    socket.deliver({ type: "status", status: "idle" });
    vi.advanceTimersByTime(RESTORE_DEADLINE_MS - 1);
    expect(typedMessage(root, "Sail tonight?"), "nothing is sent while restoring").toBe(false);
    expect(restorationOf(root.stores.chat.getState())?.phase).toBe("restoring");
    vi.advanceTimersByTime(1);
    expect(restorationOf(root.stores.chat.getState()), "the bound ends in a visible failure").toEqual({ sessionId: OGYGIA, phase: "failed", failure: { reason: "timeout" } });
    expect(root.stores.chat.getState().activeSessionId, "the selection is kept").toBe(OGYGIA);
    expect(typedMessage(root, "Sail tonight?")).toBe(false);
    expect(socket.frames("session_resume"), "a failure does not ask again by itself").toHaveLength(1);

    expect(root.connection.restore.retry()).toBe(true);
    expect(restorationOf(root.stores.chat.getState())?.phase).toBe("restoring");
    expect(socket.frames("session_resume")).toHaveLength(2);
    expect(socket.sent.map((raw) => JSON.parse(raw).type).filter((type) => type !== "session_resume" && type !== "client_hello" && type !== "ping"), "Retry sends nothing else").toEqual([]);
    socket.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    expect(restorationOf(root.stores.chat.getState())).toBeNull();
  });

  test("the bound runs from a request that left: offline, the session stays restoring", () => {
    vi.useFakeTimers();
    const root = reloaded();
    root.connection.connect();
    // The reader opens another session while the host is out of reach.
    root.stores.chat.getState().setActiveSession("aeaea-circe");
    vi.advanceTimersByTime(RESTORE_DEADLINE_MS * 2);
    expect(restorationOf(root.stores.chat.getState()), "no request ever left").toEqual({ sessionId: "aeaea-circe", phase: "restoring" });
  });

  test("every other dispatch into the unseen session is refused too", () => {
    const root = reloaded();
    const socket = connect(root);
    expect(root.connection.send({ type: "local_exchange", sessionId: OGYGIA, exchange: { id: "stats-1", command: "stats", prompt: "/stats", answer: "{}", context: "" } })).toBe(false);
    expect(root.connection.send({ type: "retry_turn", sessionId: OGYGIA, failedTurnId: "turn-0", requestId: "retry-1" })).toBe(false);
    expect(socket.frames("local_exchange")).toEqual([]);
    expect(socket.frames("retry_turn")).toEqual([]);
  });

  test("selecting a failed session again is a new attempt, not the old failure", () => {
    const root = reloaded();
    const socket = connect(root);
    socket.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    root.stores.chat.getState().setActiveSession("aeaea-circe");
    socket.deliver({ type: "session_history", sessionId: "aeaea-circe", messages: HISTORY });
    root.stores.chat.getState().setActiveSession(OGYGIA);
    expect(restorationOf(root.stores.chat.getState())?.phase).toBe("restoring");
    expect(socket.frames("session_resume").filter((f) => f.sessionId === OGYGIA), "and its history is asked for again").toHaveLength(2);
  });

  test("SESSION_LOAD_ERROR keeps the selection and fails visibly; Retry restores only that session's history", () => {
    const root = reloaded();
    const socket = connect(root);
    socket.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    expect(root.stores.chat.getState().activeSessionId).toBe(OGYGIA);
    expect(typedMessage(root, "Sail tonight?"), "a failed restoration takes no message").toBe(false);
    expect(restorationOf(root.stores.chat.getState())).toEqual({
      sessionId: OGYGIA, phase: "failed", failure: { reason: "error", message: "transcript unreadable" },
    });
    expect(typedMessage(root, "Sail tonight?")).toBe(false);
    expect(socket.frames("session_resume"), "no automatic loop on the same socket").toHaveLength(1);
    root.connection.restore.retry();
    expect(socket.frames("session_resume")).toEqual([{ type: "session_resume", sessionId: OGYGIA }, { type: "session_resume", sessionId: OGYGIA }]);
    socket.deliver({ type: "session_history", sessionId: "aeaea-circe", messages: HISTORY });
    expect(restorationOf(root.stores.chat.getState())?.phase).toBe("restoring");
    socket.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    expect(restorationOf(root.stores.chat.getState())).toBeNull();
  });

  test("New chat leaves the unrestored session; late history for it cannot take the view or the new draft back", () => {
    const root = reloaded();
    const socket = connect(root);
    socket.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    root.stores.chat.getState().clearMessages();
    expect(root.stores.chat.getState().activeSessionId).toBeNull();
    expect(restorationOf(root.stores.chat.getState())).toBeNull();
    const drafts = root.stores.drafts.getState();
    const fresh = drafts.idFor(null);
    drafts.edit(fresh, null, { text: "A new voyage plan.", attachments: [] });

    expect(typedMessage(root, "A new voyage plan.")).toBe(true);
    const [sent] = socket.frames("chat_message");
    expect(sent!.text).toBe("A new voyage plan.");
    expect(sent, "a new chat's send names no session").not.toHaveProperty("sessionId");

    socket.deliver({ type: "session_info", sessionId: OGYGIA, isNew: false });
    socket.deliver({ type: "session_history", sessionId: OGYGIA, messages: HISTORY });
    socket.deliver({ type: "status", sessionId: OGYGIA, status: "idle" });
    expect(root.stores.chat.getState().activeSessionId, "late history does not reselect the abandoned session").toBeNull();
    expect(root.stores.drafts.getState().drafts[fresh]?.text, "nor overwrite the new chat's draft").toBe("A new voyage plan.");
  });

  test("a late resume announcement never adopts a new chat's transcript, even with the old buffer gone", () => {
    const root = reloaded();
    const socket = connect(root);
    socket.deliver({ type: "error", code: "SESSION_LOAD_ERROR", message: "transcript unreadable", sessionId: OGYGIA });
    const chat = root.stores.chat.getState();
    chat.clearMessages();
    // The abandoned session's buffer was evicted meanwhile.
    root.stores.chat.setState((state) => { const buffers = { ...state.buffers }; delete buffers[OGYGIA]; return { buffers }; });
    // The new chat's first message is on its way, as the composer leaves it.
    root.stores.chat.getState().addUserMessage(null, "A new voyage plan.", "typed");
    root.stores.chat.getState().startAssistantMessage(null);
    root.stores.chat.getState().startDraftTurn();
    socket.deliver({ type: "session_info", sessionId: OGYGIA, isNew: false });
    expect(root.stores.chat.getState().activeSessionId, "the old session is not selected again").toBeNull();
    expect(root.stores.chat.getState().draft?.messages.map((m) => m.content), "the new chat keeps its transcript").toEqual(["A new voyage plan.", ""]);
  });
});
