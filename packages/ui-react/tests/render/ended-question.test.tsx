/**
 * A pending question whose turn the host's time limit ended (#3356), live,
 * on each of the four ask cards: the frames a real host sends, through the
 * real handlers, store and MessageBubble.
 *
 * Before the fix, the terminal frame turned the card into a dismissed stub:
 * the question's draft vanished with its controls, and only a separate
 * "Ask again" brought back an empty card. Now the ended card keeps the draft
 * and says the turn timed out; its Submit keeps the answer on the card as
 * Not delivered and sends nothing; only the footer's explicit Send as
 * message sends it, once, as an ordinary new message. The conversation shows
 * the timeout as a turn status, announced once.
 */
import { unregisterEndedQuestionDom } from "./ended-question-dom.js";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as renderDom, within } from "@testing-library/react";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import type { ComponentProps } from "react";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider, useBrainUiRoot } from "../../src/root-context.js";
import { useStore } from "zustand";

let root: BrainUiRoot;
afterEach(cleanup);
afterEach(() => root.dispose());
afterAll(unregisterEndedQuestionDom);
beforeEach(() => {
  root = createBrainUiRoot({ storage: null });
  root.stores.chat.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {}, deliveries: {} });
  root.stores.ui.setState({ singleKeyShortcuts: true });
});

type Kind = "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
const TURN = "turn-ithaca";
const scoped = { sessionId: "s1", turnId: TURN };

const REQUESTS: Record<Kind, ServerMessage> = {
  ask_user: { type: "ask_user_request", requestId: "req-1", ...scoped, questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor’s court" }] }] } as ServerMessage,
  ask_user_list: { type: "ask_user_list_request", requestId: "req-1", ...scoped, prompt: "Which stores are aboard?", scale: [{ label: "Aboard" }, { label: "Missing" }], items: [{ id: "oars", label: "Spare oars" }], allowSkip: false, notes: false } as ServerMessage,
  ask_user_rank: { type: "ask_user_rank_request", requestId: "req-1", ...scoped, prompt: "Rank the landings", items: [{ id: "aeolia", label: "Aeolia" }, { id: "scheria", label: "Scheria" }] } as ServerMessage,
  ask_user_form: { type: "ask_user_form_request", requestId: "req-1", ...scoped, prompt: "Plan the crossing", nodes: [{ id: "note", kind: "text", prompt: "Note for the crew", required: true }] } as ServerMessage,
};

/** The draft the user leaves on each card, and what of it a sent message must carry. */
const DRAFTS: Record<Kind, { enter: (view: ReturnType<typeof renderDom>) => void; carries: string[] }> = {
  ask_user: { enter: (view) => fireEvent.click(view.getByText("Pylos")), carries: ["Which harbour first?", "Pylos"] },
  ask_user_list: {
    enter: (view) => {
      const radio = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.includes("Missing"));
      fireEvent.click(radio!);
    },
    carries: ["Which stores are aboard?", "Spare oars", "Missing"],
  },
  ask_user_rank: {
    enter: (view) => {
      fireEvent.click(view.getByRole("button", { name: /^Scheria, position 2 of 2/ }));
      fireEvent.click(view.getByRole("button", { name: /^Aeolia, position 1 of 2/ }));
    },
    carries: ["Rank the landings", "1. Scheria", "2. Aeolia"],
  },
  ask_user_form: {
    enter: (view) => {
      const field = view.container.querySelector<HTMLTextAreaElement>("[data-form-node] textarea, textarea")!;
      fireEvent.input(field, { target: { value: "Bind the oars, Ὀδυσσεύς" } });
    },
    carries: ["Plan the crossing", "Bind the oars, Ὀδυσσεύς"],
  },
};

type Handlers = Partial<Omit<ComponentProps<typeof MessageBubble>, "message" | "onToolApproval">>;

function Live({ handlers }: { handlers: Handlers }) {
  const r = useBrainUiRoot();
  const message = useStore(r.stores.chat, (s) => s.buffers.s1?.messages.findLast((m) => m.role === "assistant"));
  if (!message) return null;
  return <MessageBubble message={message} onToolApproval={() => {}} onAskUserSubmit={() => {}} onAskUserListSubmit={() => {}} onAskUserCancel={() => {}} {...handlers} />;
}

function start(kind: Kind) {
  const calls = { submit: 0, cancel: 0, reask: [] as string[] };
  const handlers = {
    onAskUserSubmit: () => { calls.submit++; },
    onAskUserListSubmit: () => { calls.submit++; },
    onAskUserRankSubmit: () => { calls.submit++; },
    onAskUserFormSubmit: () => { calls.submit++; },
    onAskUserCancel: () => { calls.cancel++; },
    onAskUserReask: (text: string) => { calls.reask.push(text); },
  };
  const send = (frame: ServerMessage) => act(() => { root.connection.handleServerMessage(frame); });
  root.stores.chat.getState().setActiveSession("s1");
  send({ type: "session_history", sessionId: "s1", messages: [{ role: "user", content: "Plan the voyage", toolCalls: [] }] } as ServerMessage);
  send({ type: "status", status: "thinking", ...scoped } as ServerMessage);
  send({ type: "text_delta", text: "Before we sail: ", ...scoped } as ServerMessage);
  send(REQUESTS[kind]);
  const view = renderDom(<BrainUiProvider root={root}><Live handlers={handlers} /></BrainUiProvider>);
  return { view, calls, send };
}

/** What the host sends when its hard turn limit ends the turn. */
function timeOut(send: (frame: ServerMessage) => void) {
  send({ type: "status", status: "cancelled", detail: "Turn timed out", ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", outcomeDetail: "host_timeout", durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
}

const submitButton = (view: ReturnType<typeof renderDom>) =>
  view.getAllByRole("button").find((b) => /^(Submit|Keep this order|Submit order)/.test(b.textContent ?? "") || (b.getAttribute("aria-label") ?? "").startsWith("Submit"))!;

for (const kind of Object.keys(REQUESTS) as Kind[]) {
  describe(kind, () => {
    test("the ended card keeps the draft; only an explicit Send as message sends it, once", async () => {
      const { view, calls, send } = start(kind);
      DRAFTS[kind].enter(view);
      timeOut(send);

      // The turn says it timed out, as a status after the partial answer.
      const notice = view.container.querySelector('[data-turn-notice="timeout"]')!;
      expect(notice).not.toBeNull();
      expect(notice.textContent).toContain("Turn timed out");
      expect(view.container.textContent).toContain("Before we sail:");
      expect(notice.querySelector('[aria-live="polite"]')!.textContent).toContain("Turn timed out");

      // The question is still there, editable, and says it can't be answered.
      const card = view.container.querySelector("[data-ask-ended]")!;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain("The turn timed out before you answered");
      expect(view.container.querySelector("[data-answer-delivery]")).toBeNull();
      expect(calls).toEqual({ submit: 0, cancel: 0, reask: [] });

      // Submit keeps the draft on the card as Not delivered; nothing is sent.
      fireEvent.click(submitButton(view));
      expect(calls).toEqual({ submit: 0, cancel: 0, reask: [] });
      const status = view.container.querySelector('[data-answer-delivery="closed"]')!;
      expect(status).not.toBeNull();
      expect(status.querySelector("h4")!.textContent).toBe("NOT DELIVERED · QUESTION CLOSED");
      expect(status.textContent).toContain("nothing was sent");

      // Send as message is the one way out: an ordinary message with the
      // question and the user's answer, sent once.
      const sendAs = within(status as HTMLElement).getByRole("button", { name: "Send as message" });
      fireEvent.click(sendAs);
      expect(calls.submit).toBe(0);
      expect(calls.reask).toHaveLength(1);
      for (const part of DRAFTS[kind].carries) expect(calls.reask[0]).toContain(part);
      const after = view.container.querySelector('[data-answer-delivery="closed"]')!;
      expect(within(after as HTMLElement).queryByRole("button", { name: "Send as message" })).toBeNull();
      expect(after.querySelector("[data-sent-as-message]")).not.toBeNull();
      expect(document.activeElement).toBe(after.querySelector("h4"));
      expect(calls.reask).toHaveLength(1);
      expect(root.stores.chat.getState().deliveries["req-1"]).toMatchObject({ state: "closed", reason: "ended", sentAsMessage: true, submissionId: "" });
    });

    test("Dismiss on an ended card closes it here and sends nothing", () => {
      const { view, calls, send } = start(kind);
      timeOut(send);
      const dismiss = view.getAllByRole("button").find((b) => b.textContent === "Dismiss")!;
      fireEvent.click(dismiss);
      expect(calls).toEqual({ submit: 0, cancel: 0, reask: [] });
      expect(view.container.querySelector("[data-ask-ended]")).toBeNull();
      expect(view.container.textContent).toContain("no longer waiting · the turn timed out");
    });
  });
}

test("a turn that ended without the host naming a timeout says the turn ended, with no timeout notice", () => {
  const { view, send } = start("ask_user");
  send({ type: "status", status: "cancelled", ...scoped } as ServerMessage);
  send({ type: "result", outcome: "cancelled", durationMs: 1, numTurns: 1, isError: false, ...scoped } as ServerMessage);
  expect(view.container.querySelector("[data-turn-notice]")).toBeNull();
  expect(view.container.querySelector("[data-ask-ended]")!.textContent).toContain("The turn ended before you answered");
});

test("a pending question of another turn is untouched by this turn's timeout", () => {
  const { view, send } = start("ask_user");
  send({ type: "result", outcome: "cancelled", outcomeDetail: "host_timeout", durationMs: 1, numTurns: 1, isError: false, sessionId: "s1", turnId: "turn-other" } as ServerMessage);
  const messages = root.stores.chat.getState().buffers.s1!.messages;
  const asking = messages.find((m) => m.askUserExchanges?.some((e) => e.requestId === "req-1"))!;
  expect(asking.askUserExchanges![0]).not.toHaveProperty("terminal");
  // The other turn's notice does not relabel this turn's message.
  expect(asking.runtimeNotice).toBeUndefined();
  expect(view).toBeDefined();
});

describe("a runtime stop notice on replay", () => {
  function replay(messages: unknown[]) {
    root.stores.chat.getState().setActiveSession("s1");
    act(() => { root.connection.handleServerMessage({ type: "session_history", sessionId: "s1", messages } as ServerMessage); });
    return renderDom(<BrainUiProvider root={root}><Live handlers={{}} /></BrainUiProvider>);
  }

  test("draws a status after the partial answer, never the runtime's words as the agent's, and announces nothing", () => {
    const view = replay([
      { role: "user", content: "Plan the voyage", toolCalls: [] },
      { role: "assistant", content: "Before we sail: ", toolCalls: [], parts: [{ kind: "text", text: "Before we sail: " }], runtimeNotice: { cause: "unspecified", message: "No response requested." } },
    ]);
    const notice = view.container.querySelector('[data-turn-notice="unspecified"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("Turn ended without a reply");
    expect(view.container.textContent).toContain("Before we sail:");
    expect(view.container.textContent).not.toContain("No response requested.");
    expect(notice.querySelector('[aria-live="polite"]')!.textContent).toBe("");
  });

  test("an aborted request says the request was aborted, not who stopped it", () => {
    const view = replay([
      { role: "user", content: "Plan the voyage", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [], parts: [], runtimeNotice: { cause: "aborted", message: "API Error: Request was aborted." } },
    ]);
    const notice = view.container.querySelector('[data-turn-notice="aborted"]')!;
    expect(notice.textContent).toContain("request was aborted");
    expect(notice.textContent).not.toMatch(/you cancelled|cancelled by/i);
    expect(view.container.textContent).not.toContain("API Error");
  });

  test("a failure on the same message stays the one account of the stop", () => {
    const view = replay([
      { role: "user", content: "Plan the voyage", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [], parts: [], failure: { errorClass: "overloaded", message: "API Error: 529 Overloaded" }, runtimeNotice: { cause: "unspecified", message: "No response requested." } },
    ]);
    expect(view.container.querySelector("[data-turn-failure]")).not.toBeNull();
    expect(view.container.querySelector("[data-turn-notice]")).toBeNull();
  });

  test("the model's own words quoting a notice stay its answer", () => {
    const view = replay([
      { role: "user", content: "What does the runtime write?", toolCalls: [] },
      { role: "assistant", content: "It writes No response requested.", toolCalls: [], parts: [{ kind: "text", text: "It writes No response requested." }] },
    ]);
    expect(view.container.textContent).toContain("It writes No response requested.");
    expect(view.container.querySelector("[data-turn-notice]")).toBeNull();
  });
});
