// Text and thinking deltas are coalesced into one store write per animation
// frame. These tests pin the two properties that makes safe: a burst becomes a
// single write, and nothing ever reorders.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat } from "../src/stores/chat-store";
import { defaultRoot } from "../src/default-root";
import type { TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";

const { handleServerMessage, flushChatDeltas } = defaultRoot.connection;

/** Frame callbacks the handler queued, run only when a test says to. */
let frames: FrameRequestCallback[] = [];
const hadRaf = "requestAnimationFrame" in globalThis;
const originalRaf = globalThis.requestAnimationFrame;

function paint(): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

beforeEach(() => {
  flushChatDeltas();
  frames = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

afterEach(() => {
  if (hadRaf) globalThis.requestAnimationFrame = originalRaf;
  else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
});

function delta(text: string): void {
  handleServerMessage({ type: "text_delta", text } as ServerMessage);
}

describe("delta batching", () => {
  test("a burst of deltas within one frame becomes a single store write", () => {
    delta("Hello");
    delta(" there");
    delta(", world");

    // The bubble opens immediately — the first token should show a message
    // starting — but the text has not landed yet.
    expect(activeChat(useChatStore.getState()).messages).toHaveLength(1);
    expect(activeChat(useChatStore.getState()).messages[0].content).toBe("");

    const writes: string[] = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      writes.push(activeChat(state).messages[0].content);
    });
    try {
      paint();
      expect(writes).toEqual(["Hello there, world"]);
    } finally {
      unsubscribe();
    }

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.content).toBe("Hello there, world");
    // The resulting part remains coalesced as well.
    expect(msg.parts).toEqual([{ kind: "text", text: "Hello there, world" }]);
  });

  test("thinking and text keep their arrival order through a batch", () => {
    handleServerMessage({ type: "thinking_delta", text: "let me " } as ServerMessage);
    handleServerMessage({ type: "thinking_delta", text: "check" } as ServerMessage);
    delta("The answer");
    handleServerMessage({ type: "thinking_delta", text: "hmm" } as ServerMessage);
    delta(" is 42");

    paint();

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.parts).toEqual([
      { kind: "thinking", text: "let me check" },
      { kind: "text", text: "The answer" },
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: " is 42" },
    ]);
    expect(msg.content).toBe("The answer is 42");
    expect(msg.thinking).toBe("let me checkhmm");
  });

  test("a non-delta frame lands after the text that preceded it, not before", () => {
    delta("Reading the file");
    // No paint: the text is still buffered when the tool call arrives.
    handleServerMessage({
      type: "tool_use_start",
      toolUseId: "t1",
      toolName: "Read",
    } as ServerMessage);
    delta("Done");
    paint();

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.parts).toEqual([
      { kind: "text", text: "Reading the file" },
      { kind: "tool", toolIndex: 0 },
      { kind: "text", text: "Done" },
    ]);
  });

  test("deltas for different sessions stay in their own buffers", () => {
    const store = useChatStore.getState();
    store.setMessages("A", []);
    store.setMessages("B", []);

    handleServerMessage({ type: "text_delta", text: "for A", sessionId: "A" } as ServerMessage);
    handleServerMessage({ type: "text_delta", text: "for B", sessionId: "B" } as ServerMessage);
    handleServerMessage({ type: "text_delta", text: " more A", sessionId: "A" } as ServerMessage);
    paint();

    const state = useChatStore.getState();
    expect(state.buffers.A.messages[0].content).toBe("for A more A");
    expect(state.buffers.B.messages[0].content).toBe("for B");
  });

  test("any non-delta frame applies whatever was still buffered", () => {
    delta("half a sentence");
    // A hidden tab never gets an animation frame, so the buffer must not
    // depend on one to drain.
    handleServerMessage({ type: "status", status: "idle" } as ServerMessage);

    expect(activeChat(useChatStore.getState()).messages[0].content).toBe(
      "half a sentence"
    );
  });
});

// A host stamps `turnId` on every turn-scoped frame (#4739), so the batching
// above has to hold for stamped frames too, and so does every write that
// changes nothing.
describe("writes that change nothing", () => {
  function notifications(run: () => void): number {
    let count = 0;
    const unsubscribe = useChatStore.subscribe(() => { count++; });
    try {
      run();
    } finally {
      unsubscribe();
    }
    return count;
  }

  function stampedDelta(text: string): void {
    handleServerMessage({ type: "text_delta", text, sessionId: "A", turnId: "turn-1" } as ServerMessage);
  }

  test("stamped deltas after the first frame write the store once per animation frame", () => {
    useChatStore.getState().setMessages("A", []);
    stampedDelta("Hello");
    paint();
    const N = 50;
    expect(notifications(() => { for (let i = 0; i < N; i++) stampedDelta(` ${i}`); })).toBe(0);
    expect(notifications(() => paint())).toBe(1);
    const msg = useChatStore.getState().buffers.A!.messages[0]!;
    expect(msg.turnId).toBe("turn-1");
    expect(msg.content).toBe("Hello" + Array.from({ length: N }, (_, i) => ` ${i}`).join(""));
  });

  test("stampTurn, setRetry and finishHistoryReplay notify nobody when they change nothing", () => {
    const store = useChatStore.getState();
    store.setMessages("A", []);
    store.startAssistantMessage("A", "turn-1");
    store.stampTurn("A", "turn-1");
    const before = useChatStore.getState().buffers.A;
    expect(before!.messages[0]!.turnId).toBe("turn-1");
    expect(notifications(() => store.stampTurn("A", "turn-1"))).toBe(0);
    expect(notifications(() => store.stampTurn("A", "turn-2"))).toBe(0);
    expect(before!.messages[0]!.retry).toBeUndefined();
    expect(notifications(() => store.setRetry("A", null))).toBe(0);
    expect(before!.replay).toBeUndefined();
    expect(notifications(() => store.finishHistoryReplay("A"))).toBe(0);
    // Nothing was touched, so the buffer's place in the eviction order holds.
    expect(useChatStore.getState().buffers.A).toBe(before);
  });

  test("a call that changes nothing still stamps a journal receipt the message is missing", () => {
    const receipt = { state: "complete", changedFiles: 1 } as unknown as TurnJournalSummary;
    const store = useChatStore.getState();
    store.setMessages("A", []);
    store.startAssistantMessage("A", "turn-1");
    store.stampTurn("A", "turn-1");
    // A replay chunk replaces messages with a direct set that never restamps.
    const buffer = useChatStore.getState().buffers.A!;
    useChatStore.setState({ buffers: { A: { ...buffer, journals: { "turn-1": receipt } } } });
    expect(useChatStore.getState().buffers.A!.messages[0]!.journal).toBeUndefined();

    expect(notifications(() => store.setRetry("A", null))).toBe(1);
    const msg = useChatStore.getState().buffers.A!.messages[0]!;
    expect(msg.journal).toBe(receipt);
    expect(msg.journalLive).toBe(true);
    // Stamped now, so the same call is a no-op again.
    expect(notifications(() => store.setRetry("A", null))).toBe(0);
  });
});
