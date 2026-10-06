// The typed answer (D38 §1): composer text while a question is pending is the
// answer, marked `typed`, and handed to the answer queue (#910).
import type { SubmitAnswer } from "../src/lib/answer-delivery/manager";
import { describe, test, expect, beforeEach } from "bun:test";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
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
    const sent: SubmitAnswer[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    expect(takeComposerTextAsAnswer(store, null, "hello", (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a pending question takes the text as its answer and nothing goes out as chat", () => {
    const sent: SubmitAnswer[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-3", Q);
    expect(isPendingExchange(draft().askUser)).toBe(true);

    const taken = takeComposerTextAsAnswer(useChatStore.getState(), null, "  neither, do both  ", (m) => sent.push(m));
    expect(taken).toBe(true);
    // The answer goes to the queue (#910), typed, bound to the session, and
    // leaves the composer focused.
    expect(sent).toEqual([
      {
        requestId: "req-3",
        sessionId: null,
        payload: { kind: "ask_user", answers: { "Which approach?": "neither, do both" }, typed: true },
        focus: false,
      },
    ]);
    // What the queue does once the answer is saved on this device.
    useChatStore.getState().submitAskUserAnswers(null, "req-3", sent[0]!.payload.kind === "ask_user" ? sent[0]!.payload.answers : {}, undefined, true);
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
    const sent: SubmitAnswer[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-4", Q);
    store.cancelAskUser(null, "req-4");
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "hi", (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
  });

  test("only a single-question exchange has a question for a typed answer", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-q", Q);
    expect(questionForTypedAnswer(draft().askUser!)?.question).toBe("Which approach?");
    store.setAskUserRequest(null, "req-q2", Q2);
    expect(questionForTypedAnswer(draft().askUser!)).toBeNull();
  });

  test("a multi-question prompt is not answered by the composer", () => {
    // The server resolves the whole request on the first response, so a
    // typed reply bound to question one would leave the others blank and
    // unanswerable. The cards' own Submit gathers all of them instead.
    const sent: SubmitAnswer[] = [];
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-6", Q2);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "keep it", (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
    expect(draft().askUser?.answers).toBeUndefined();
  });

  test("ranking keeps composer text ordinary and a completed order is no longer pending", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRankRequest(null, "rank-1", { prompt: "Which first?", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const sent: SubmitAnswer[] = [];
    expect(draft().askUser?.rank?.items).toHaveLength(2);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "B first", (message) => sent.push(message))).toBe(false);
    expect(sent).toEqual([]);
    expect(draft().askUser?.order).toBeUndefined();
    store.submitAskUserRankOrder(null, "rank-1", ["b", "a"], false);
    expect(draft().askUser?.order).toEqual(["b", "a"]);
    expect(isPendingExchange(draft().askUser)).toBe(false);
  });

  test("blank text takes nothing", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-5", Q);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), null, "   ", () => {})).toBe(false);
    expect(draft().askUser?.answers).toBeUndefined();
  });

  test("works on a bound session buffer, not only the draft", () => {
    const sent: SubmitAnswer[] = [];
    const store = useChatStore.getState();
    store.setMessages("s1", []);
    store.startAssistantMessage("s1");
    store.setAskUserRequest("s1", "req-7", Q);
    expect(takeComposerTextAsAnswer(useChatStore.getState(), "s1", "modal", (m) => sent.push(m))).toBe(true);
    expect(sent).toEqual([
      { requestId: "req-7", sessionId: "s1", payload: { kind: "ask_user", answers: { "Which approach?": "modal" }, typed: true }, focus: false },
    ]);
  });
});
