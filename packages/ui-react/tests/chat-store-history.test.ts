import { describe, test, expect, beforeEach } from "bun:test";

// Bun's test env has no DOM localStorage; the store guards against that, but
// these tests assert the persistence path, so install an in-memory stub.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: () => null,
  length: 0,
} as Storage;

import { useChatStore, type ChatMessage } from "../src/stores/chat-store";

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
