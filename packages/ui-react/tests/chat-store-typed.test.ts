// The typed answer (D38 §1): composer text while a question is pending is the
// answer, marked `typed` on the exchange and sent as `ask_user_response`.
import { describe, test, expect, beforeEach } from "bun:test";
import type { AskUserQuestion, ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore } from "../src/stores/chat-store";
import {
  isPendingExchange,
  questionForTypedAnswer,
  takeComposerTextAsAnswer,
} from "../src/components/chat/ask-user-typed";

const Q: AskUserQuestion[] = [
  {
    question: "Which approach?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Inline", description: "" },
      { label: "Modal", description: "" },
    ],
  },
];
const Q2: AskUserQuestion[] = [
  Q[0],
  { question: "And the name?", header: "Name", multiSelect: false, options: [{ label: "Keep", description: "" }] },
];

beforeEach(() => {
  useChatStore.setState({ buffers: {}, draft: null, activeSessionId: null, runStates: {} });
});

function draft() {
  return useChatStore.getState().draft!;
}

describe("submitAskUserAnswers · typed", () => {
  test("marks the exchange typed and stamps when it was answered", () => {
    const before = Date.now();
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-1", Q);
    store.submitAskUserAnswers(null, "req-1", { "Which approach?": "my own way" }, undefined, true);

    const ex = draft().messages.at(-1)!.askUserExchanges![0];
    expect(ex.typed).toBe(true);
    expect(ex.answeredAt).toBeGreaterThanOrEqual(before);
    expect(draft().askUser?.typed).toBe(true);
  });

  test("a chosen answer is not typed but still knows when", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-2", Q);
    store.submitAskUserAnswers(null, "req-2", { "Which approach?": "Inline" });
    const ex = draft().messages.at(-1)!.askUserExchanges![0];
    expect(ex.typed).toBeUndefined();
    expect(typeof ex.answeredAt).toBe("number");
  });
});

describe("takeComposerTextAsAnswer", () => {
  test("nothing pending: the text stays a message", () => {
    const sent: ClientMessage[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    expect(takeComposerTextAsAnswer(store, null, "hello", (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a pending question takes the text as its answer and nothing goes out as chat", () => {
    const sent: ClientMessage[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-3", Q);
    expect(isPendingExchange(draft().askUser)).toBe(true);

    const taken = takeComposerTextAsAnswer(useChatStore.getState(), null, "  neither, do both  ", (m) => sent.push(m));
    expect(taken).toBe(true);
    expect(sent).toEqual([
      { type: "ask_user_response", requestId: "req-3", answers: { "Which approach?": "neither, do both" } },
    ]);
    const ex = draft().messages.at(-1)!.askUserExchanges![0];
    expect(ex.answers).toEqual({ "Which approach?": "neither, do both" });
    expect(ex.typed).toBe(true);
    // The user message count is unchanged: the text was an answer, not a turn.
    expect(draft().messages.filter((m) => m.role === "user")).toHaveLength(0);

    // Answered now: the next send is a message again.
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "next", (m) => sent.push(m))).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("a dismissed question takes nothing", () => {
    const sent: ClientMessage[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-4", Q);
    store.cancelAskUser(null, "req-4");
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "hi", (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("blank text takes nothing", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-5", Q);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "   ", () => {})).toBe(false);
    expect(draft().askUser?.answers).toBeUndefined();
  });

  test("several questions: the text answers the first, and only the first", () => {
    const sent: ClientMessage[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-6", Q2);
    expect(questionForTypedAnswer(draft().askUser!)?.question).toBe("Which approach?");
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "inline", (m) => sent.push(m))).toBe(true);
    expect(sent[0]).toEqual({
      type: "ask_user_response",
      requestId: "req-6",
      answers: { "Which approach?": "inline" },
    });
  });

  test("works on a bound session buffer, not only the draft", () => {
    const sent: ClientMessage[] = [];
    const store = useChatStore.getState();
    store.setMessages("s1", []);
    store.startAssistantMessage("s1");
    store.setAskUserRequest("s1", "req-7", Q);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), "s1", "modal", (m) => sent.push(m))).toBe(true);
    expect(useChatStore.getState().buffers["s1"].askUser?.typed).toBe(true);
  });
});
