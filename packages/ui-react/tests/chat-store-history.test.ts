import { afterAll, beforeAll, describe, test, expect, beforeEach } from "bun:test";
import { useChatStore, type ChatMessage } from "../src/stores/chat-store";
import { emptyChat } from "../src/stores/chat-slices/buffers";

// Bun's test env has no DOM localStorage; the store guards against that, but
// these tests assert the persistence path, so install an in-memory stub for
// this file only and put back whatever was there before, so no later file in
// the same process inherits the stub or its keys.
const backing = new Map<string, string>();
const stub = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: () => null,
  length: 0,
} as Storage;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: stub });
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function msg(id: string, content: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    toolCalls: [],
    parts: [{ kind: "text", text: content }],
    isStreaming: false,
    timestamp: 0,
  };
}

beforeEach(() => {
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

describe("chunked history replay", () => {
  test("setMessages replaces, then appendMessages concatenates in order", () => {
    const store = useChatStore.getState();
    // First (replacing) chunk.
    store.setMessages(null, [msg("a", "one"), msg("b", "two")]);
    // Continuation chunks.
    store.appendMessages(null, [msg("c", "three")]);
    store.appendMessages(null, [msg("d", "four")]);

    const messages = useChatStore.getState().draft!.messages;
    expect(messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("a replacing chunk after appends starts a fresh transcript", () => {
    const store = useChatStore.getState();
    store.setMessages(null, [msg("a", "one")]);
    store.appendMessages(null, [msg("b", "two")]);
    // A new resume cycle replaces everything.
    store.setMessages(null, [msg("x", "fresh")]);

    expect(useChatStore.getState().draft!.messages.map((m) => m.id)).toEqual(["x"]);
  });

  test("appendMessages leaves streaming state untouched", () => {
    for (const key of [null, "sess-running"]) {
      const store = useChatStore.getState();
      store.setMessages(key, [msg("a", "one")]);
      store.setStreaming(key, true);
      store.appendMessages(key, [msg("b", "two")]);
      const state = useChatStore.getState();
      const buffer = key === null ? state.draft! : state.buffers[key];
      expect(buffer.messages.map((message) => message.id)).toEqual(["a", "b"]);
      expect(buffer.isStreaming).toBe(true);
      store.setStreaming(key, false);
      store.appendMessages(key, [msg("c", "three")]);
      const updated = useChatStore.getState();
      expect((key === null ? updated.draft! : updated.buffers[key]).isStreaming).toBe(false);
    }
  });

  test("setMessages and appendMessages create the buffer for their session key", () => {
    const store = useChatStore.getState();
    store.setMessages("sess-r", [msg("a", "one")]);
    store.appendMessages("sess-r", [msg("b", "two")]);

    const buffer = useChatStore.getState().buffers["sess-r"];
    expect(buffer.messages.map((m) => m.id)).toEqual(["a", "b"]);
    // Replay never lands in the draft.
    expect(useChatStore.getState().draft).toBeNull();
  });
});

describe("session id durability", () => {
  test("setActiveSession persists to localStorage (survives a PWA relaunch)", () => {
    useChatStore.getState().setActiveSession("sess-123");
    expect(localStorage.getItem("brain-sessionId")).toBe("sess-123");
    expect(useChatStore.getState().activeSessionId).toBe("sess-123");
  });

  test("bindDraftSession persists the adopted session id", () => {
    useChatStore.getState().addUserMessage(null, "hi");
    useChatStore.getState().bindDraftSession("sess-456");
    expect(localStorage.getItem("brain-sessionId")).toBe("sess-456");
    expect(useChatStore.getState().activeSessionId).toBe("sess-456");
  });

  test("clearMessages drops the persisted session id", () => {
    useChatStore.getState().setActiveSession("sess-123");
    useChatStore.getState().clearMessages();
    expect(localStorage.getItem("brain-sessionId")).toBeNull();
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });
});

describe("a chunked replay over a transcript already drawn (#4747)", () => {
  const KEY = "ithaca";
  const say = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    ...msg(id, content), role, ...extra,
  });
  const draw = (messages: ChatMessage[], isStreaming = false) =>
    useChatStore.setState({ buffers: { [KEY]: { ...emptyChat(), messages, isStreaming } } });
  const drawn = () => useChatStore.getState().buffers[KEY]!;
  /**
   * The history copy of a message, counting the reconciliations it takes
   * part in: reconciling a received message filters its parts once, while
   * the spreads that copy the replay never call a method on them.
   */
  function counted(m: ChatMessage, log: string[]): ChatMessage {
    const parts = [...m.parts];
    Object.defineProperty(parts, "filter", {
      enumerable: false,
      value(this: ChatMessage["parts"], ...args: Parameters<ChatMessage["parts"]["filter"]>) {
        log.push(m.id);
        return Array.prototype.filter.apply(this, args);
      },
    });
    return { ...m, id: `history-${m.id}`, timestamp: 0, parts };
  }
  const transcript = (n: number) => Array.from({ length: n }, (_, i) =>
    say(`m${i}`, i % 2 === 0 ? "user" : "assistant", `${i % 2 === 0 ? "Where is" : "Ithaca lies"} ${i}`, { timestamp: 100 + i }));

  test("a message an earlier chunk reconciled keeps its object through the later chunks", () => {
    const screen = transcript(6);
    draw(screen);
    const store = useChatStore.getState();
    store.setMessages(KEY, screen.slice(0, 2).map((m) => counted(m, [])));
    const first = drawn().messages[0]!;
    expect(first.id).toBe("m0");
    store.appendMessages(KEY, screen.slice(2, 4).map((m) => counted(m, [])));
    store.appendMessages(KEY, screen.slice(4, 6).map((m) => counted(m, [])));
    expect(drawn().messages[0]).toBe(first);
    expect(drawn().messages.map((m) => m.id)).toEqual(screen.map((m) => m.id));
    expect(drawn().replay!.received).toHaveLength(6);
  });

  test("each continuation chunk reconciles only its own messages", () => {
    const screen = transcript(6);
    draw(screen);
    const store = useChatStore.getState();
    const log: string[] = [];
    const chunk = (from: number, to: number) => screen.slice(from, to).map((m) => counted(m, log));
    store.setMessages(KEY, chunk(0, 2));
    expect(log.splice(0)).toEqual(["m0", "m1"]);
    store.appendMessages(KEY, chunk(2, 4));
    expect(log.splice(0)).toEqual(["m2", "m3"]);
    store.appendMessages(KEY, chunk(4, 6));
    expect(log.splice(0)).toEqual(["m4", "m5"]);
  });

  test("the live answer an earlier chunk held back as its tail is reconciled again, and ends once a message follows it", () => {
    const screen = [say("u1", "user", "Where is Ithaca"), say("a1", "assistant", "West, past", { isStreaming: true, turnId: "turn-1" })];
    draw(screen, true);
    const store = useChatStore.getState();
    const log: string[] = [];
    store.setMessages(KEY, [counted(screen[0]!, log), counted({ ...screen[1]!, isStreaming: false }, log)]);
    expect(log.splice(0)).toEqual(["u1", "a1"]);
    expect(drawn().isStreaming).toBe(true);
    const first = drawn().messages[0]!;
    store.appendMessages(KEY, [counted(say("u2", "user", "And then?"), log), counted(say("a2", "assistant", "Home"), log)]);
    // The held tail only: the new messages have nothing drawn to keep.
    expect(log.splice(0)).toEqual(["a1"]);
    expect(drawn().messages[0]).toBe(first);
    expect(drawn().messages.map((m) => [m.id, m.isStreaming])).toEqual([["u1", false], ["a1", false], ["history-u2", false], ["history-a2", false]]);
    expect(drawn().isStreaming).toBe(false);
  });

  test("a chunk boundary at a user message another client inserted keeps the live answer until its chunk arrives", () => {
    const screen = [say("u1", "user", "Where is Ithaca"), say("a1", "assistant", "West, past", { isStreaming: true, turnId: "turn-2" })];
    draw(screen, true);
    const store = useChatStore.getState();
    store.setMessages(KEY, [counted(screen[0]!, [])]);
    // The second chunk stops at the user message this page never saw sent.
    store.appendMessages(KEY, [counted(say("u-other", "user", "Row harder"), [])]);
    expect(drawn().messages.map((m) => [m.id, m.isStreaming, m.turnId, m.streamTurnId])).toEqual([
      ["u1", false, undefined, undefined],
      ["history-u-other", false, undefined, undefined],
      ["a1", true, undefined, "turn-2"],
    ]);
    expect(drawn().isStreaming).toBe(true);
    // The answer's chunk moves it across the inserted message, still live.
    store.appendMessages(KEY, [counted(say("a1", "assistant", "West, past Scylla", { turnId: "turn-2" }), [])]);
    expect(drawn().messages.map((m) => [m.id, m.content, m.isStreaming])).toEqual([
      ["u1", "Where is Ithaca", false],
      ["history-u-other", "Row harder", false],
      ["a1", "West, past Scylla", true],
    ]);
    expect(drawn().isStreaming).toBe(true);
  });

  test("a streaming answer that arrives in the last chunk stays the live answer", () => {
    const screen = [...transcript(4), say("a-live", "assistant", "The suitors", { isStreaming: true, turnId: "turn-3" })];
    draw(screen, true);
    const store = useChatStore.getState();
    store.setMessages(KEY, screen.slice(0, 2).map((m) => counted(m, [])));
    store.appendMessages(KEY, screen.slice(2, 4).map((m) => counted(m, [])));
    // Until then the drawn answer is the kept suffix.
    expect(drawn().messages.at(-1)!.id).toBe("a-live");
    store.appendMessages(KEY, [counted(say("a-live", "assistant", "The suitors feast", { turnId: "turn-3" }), [])]);
    expect(drawn().messages.map((m) => m.id)).toEqual(screen.map((m) => m.id));
    expect(drawn().messages.at(-1)).toMatchObject({ content: "The suitors feast", isStreaming: true });
    expect(drawn().isStreaming).toBe(true);
  });
});
