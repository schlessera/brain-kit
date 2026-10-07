/**
 * Every delivery state of the approved design's §3 (#910), on each of the
 * four ask cards, with a nonempty multibyte answer: the exact tag, body,
 * actions and meta line, and the submitted answer still visible.
 */
import { unregisterAnswerDeliveryDom } from "./answer-delivery-dom.js";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { flushChatDeltas, handleServerMessage } from "../../src/hooks/use-websocket.js";
import { useChatStore } from "../../src/stores/chat-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import type { AnswerDelivery, AnswerPayload, DeliveryState } from "../../src/lib/answer-delivery/types.js";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

afterEach(cleanup);
afterAll(unregisterAnswerDeliveryDom);
beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {}, deliveries: {} });
  useUIStore.setState({ singleKeyShortcuts: true });
});

type Kind = AnswerPayload["kind"];
const HARBOUR = "Ithaca — Ἰθάκη";
const NOTE = "Timber and rope, σχεδία";
const CASES: Record<Kind, { tool: string; input: Record<string, unknown>; payload: AnswerPayload; shows: string }> = {
  ask_user: {
    tool: "mcp__brain-ui__ask_user",
    input: { questions: [{ question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: HARBOUR, description: "Home" }, { label: "Pylos", description: "Nestor" }] }] },
    payload: { kind: "ask_user", answers: { "Which harbour first?": HARBOUR } },
    shows: HARBOUR,
  },
  ask_user_list: {
    tool: "mcp__brain-ui__ask_user_list",
    input: { prompt: "Choose raft supplies", items: [{ id: "rope", label: "Rope · σχοινί" }], scale: [{ label: "Pack" }, { label: "Leave" }], allowSkip: false, notes: false },
    payload: { kind: "ask_user_list", answers: { rope: "Pack" } },
    shows: "Rope · σχοινί",
  },
  ask_user_rank: {
    tool: "mcp__brain-ui__ask_user_rank",
    input: { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber ξύλα" }] },
    payload: { kind: "ask_user_rank", order: ["timber", "rope"], unchanged: false },
    shows: "Timber ξύλα",
  },
  ask_user_form: {
    tool: "mcp__brain-ui__ask_user_form",
    input: { prompt: "Record raft supplies", nodes: [{ id: "note", kind: "text", prompt: "Supply note", required: true }] },
    payload: { kind: "ask_user_form", answers: { note: { value: NOTE } }, visibleNodes: ["note"] },
    shows: NOTE,
  },
};

const T = new Date(2026, 6, 12, 9, 41).getTime();
const SETTLED = new Date(2026, 6, 12, 9, 42).getTime();

/** The §3 table, as rendered text. */
const EXPECTED: Record<Exclude<DeliveryState, "saving">, { tag: string; body: string; actions: string[]; meta?: string; patch?: Partial<AnswerDelivery> }> = {
  queued: { tag: "NOT SENT YET · SAVED ON THIS DEVICE", body: "You're offline. Your answer sends automatically when you're back.", actions: ["Cancel sending"], meta: "queued 09:41 · stops after 24 h" },
  awaiting: { tag: "SENT · WAITING FOR THE HOST", body: "Your answer was sent. Waiting for the host to confirm it got it.", actions: [], meta: "checking again in 5 s if no reply" },
  answered: { tag: "ANSWERED", body: "The host received your answer.", actions: [], meta: "confirmed 09:42" },
  closed: { tag: "NOT DELIVERED · QUESTION CLOSED", body: "This question ended before your answer arrived. Your answer is kept below.", actions: ["Copy answer", "Send as message"], meta: "turn ended 09:42 · nothing was sent", patch: { reason: "ended" } },
  expired: { tag: "NOT SENT · STOPPED TRYING", body: "This answer waited more than 24 hours and wasn't sent.", actions: ["Copy answer", "Send as message"], meta: "queued 12 Jul 09:41" },
  cancelled: { tag: "NOT SENT · CANCELLED", body: "You stopped this answer before it was sent.", actions: ["Edit"], patch: { editable: true } },
  update: { tag: "CAN'T SEND · UPDATE NEEDED", body: "This app or the host is too old to confirm answers. Your answer is kept.", actions: ["Reload app"], meta: "answers need receipt support" },
  full: { tag: "CAN'T SAVE MORE ANSWERS", body: "16 answers are already waiting to send. This one stays here, unsent.", actions: ["Try again"], meta: "16 / 16 queued · nothing dropped", patch: { full: "count" } },
  notSaved: { tag: "NOT SAVED ON THIS DEVICE", body: "This device couldn't save your answer, so it can't send it later. Stay online and try again.", actions: ["Try again"] },
  signedOut: { tag: "NOT SENT · SIGNED OUT", body: "You signed out before this answer was confirmed. Your answer is kept.", actions: ["Copy answer"] },
};
const ANNOUNCED = new Set(["queued", "awaiting", "answered", "closed", "update", "full"]);
const ALL_ACTIONS = ["Cancel sending", "Copy answer", "Send as message", "Edit", "Reload app", "Try again"];

function mount(kind: Kind, delivery: AnswerDelivery | null) {
  const c = CASES[kind];
  const messages: SessionHistoryMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: c.tool, input: c.input }], parts: [{ kind: "tool", toolIndex: 0 }] },
  ];
  useChatStore.getState().setActiveSession("s1");
  handleServerMessage({ type: "session_history", sessionId: "s1", messages });
  if (delivery) useChatStore.getState().setDelivery("toolu_1", delivery);
  const message = useChatStore.getState().buffers.s1!.messages[0]!;
  const noop = () => {};
  return render(<MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop} onAskUserListSubmit={noop} onAskUserCancel={noop} onAskUserReask={noop} />);
}

for (const kind of Object.keys(CASES) as Kind[]) {
  describe(kind, () => {
    for (const [state, expected] of Object.entries(EXPECTED) as Array<[Exclude<DeliveryState, "saving">, (typeof EXPECTED)["queued"]]>) {
      test(`${state}: exact tag, body, actions and meta; the answer stays visible`, () => {
        const view = mount(kind, {
          requestId: "toolu_1",
          submissionId: "sub-1",
          sessionId: "s1",
          state,
          payload: CASES[kind].payload,
          submittedAt: T,
          settledAt: SETTLED,
          ...expected.patch,
        });
        const status = view.container.querySelector(`[data-answer-delivery="${state}"]`)!;
        expect(status).not.toBeNull();
        expect(status.querySelector("h4")!.textContent).toBe(expected.tag);
        expect(status.querySelector("h4")!.getAttribute("tabindex")).toBe("-1");
        expect(status.textContent).toContain(expected.body);
        if (expected.meta) expect(status.textContent).toContain(expected.meta);
        const buttons = [...status.querySelectorAll('[role="button"]')].map((b) => b.textContent);
        expect(buttons.filter((b) => ALL_ACTIONS.includes(b ?? ""))).toEqual(expected.actions);
        const live = status.querySelector('[aria-live="polite"]')!.textContent;
        expect(live).toBe(ANNOUNCED.has(state) ? `${expected.tag}. ${expected.body}` : "");
        if (expected.actions.includes("Send as message")) {
          expect(status.textContent).toContain("Sends a new chat message; it doesn't answer this question.");
        }
        if (state === "full" || state === "notSaved") {
          // Nothing was admitted: the card is still the editable question,
          // holding whatever the user entered (the browser test proves the
          // draft survives); it does not turn into a read-only record.
          expect(view.container.textContent).toContain("Dismiss");
        } else {
          // The submitted answer is on screen in every other state.
          expect(view.container.textContent).toContain(CASES[kind].shows);
          // And the card above the footer says "Answered" only once the host has.
          const card = view.container.textContent!.replace(status.textContent!, "");
          if (state === "answered") {
            expect(card).toContain("Answered");
            expect(card).not.toContain("Your answer");
          } else {
            expect(card).not.toContain("Answered");
            expect(card).toContain("Your answer");
          }
        }
      });
    }

    test("Edit never appears for an answer that may already have been delivered", () => {
      for (const state of ["queued", "awaiting"] as const) {
        cleanup();
        const view = mount(kind, { requestId: "toolu_1", submissionId: "sub-1", sessionId: "s1", state, payload: CASES[kind].payload, submittedAt: T, editable: true });
        const status = view.container.querySelector("[data-answer-delivery]");
      expect(status).not.toBeNull();
      const buttons = [...status!.querySelectorAll('[role="button"]')].map((b) => b.textContent);
        expect(buttons).not.toContain("Edit");
      }
    });

    test("a cancelled answer the host has not confirmed as still wanted offers no Edit", () => {
      const view = mount(kind, { requestId: "toolu_1", submissionId: "sub-1", sessionId: "s1", state: "cancelled", payload: CASES[kind].payload, submittedAt: T });
      const status = view.container.querySelector("[data-answer-delivery]");
      expect(status).not.toBeNull();
      const buttons = [...status!.querySelectorAll('[role="button"]')].map((b) => b.textContent);
      expect(buttons).not.toContain("Edit");
    });

    test("a mirror in another tab shows the state with no actions", () => {
      const view = mount(kind, { requestId: "toolu_1", submissionId: "sub-1", sessionId: "s1", state: "queued", payload: CASES[kind].payload, submittedAt: T, mirror: true });
      const status = view.container.querySelector('[data-answer-delivery="queued"]')!;
      expect(status.querySelector("h4")!.textContent).toBe(EXPECTED.queued.tag);
      expect(status.querySelectorAll('[role="button"]')).toHaveLength(0);
    });
  });
}

test("the byte budget's Full names megabytes", () => {
  const view = mount("ask_user", { requestId: "toolu_1", submissionId: "", sessionId: "s1", state: "full", full: "bytes", payload: CASES.ask_user.payload, submittedAt: T });
  const status = view.container.querySelector('[data-answer-delivery="full"]')!;
  expect(status.textContent).toContain("16 MB of answers are already waiting to send. This one stays here, unsent.");
  expect(status.textContent).toContain("16 MB queued · nothing dropped");
});

test("a closed answer the host did not recognise says so", () => {
  const view = mount("ask_user", { requestId: "toolu_1", submissionId: "s", sessionId: "s1", state: "closed", reason: "not_recognized", payload: CASES.ask_user.payload, submittedAt: T, settledAt: SETTLED });
  expect(view.container.querySelector('[data-answer-delivery="closed"]')!.textContent).toContain("not recognized by the host");
});

test("while the answer is being saved the card stays the editable question", () => {
  const view = mount("ask_user_form", { requestId: "toolu_1", submissionId: "", sessionId: "s1", state: "saving", payload: CASES.ask_user_form.payload, submittedAt: T });
  expect(view.container.querySelector('[data-answer-delivery="saving"] h4')!.textContent).toBe("SAVING…");
  expect(view.container.querySelector("textarea, input")).not.toBeNull();
});

test("a question another answer closed still shows the answer this user submitted", () => {
  const c = CASES.ask_user;
  const messages: SessionHistoryMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_1", name: c.tool, input: c.input, output: JSON.stringify({ answers: { "Which harbour first?": "Pylos" } }) }],
      parts: [{ kind: "tool", toolIndex: 0 }],
    },
  ];
  useChatStore.getState().setActiveSession("s1");
  handleServerMessage({ type: "session_history", sessionId: "s1", messages });
  useChatStore.getState().setDelivery("toolu_1", { requestId: "toolu_1", submissionId: "s", sessionId: "s1", state: "closed", reason: "answered_elsewhere", payload: c.payload, submittedAt: T, settledAt: SETTLED });
  const message = useChatStore.getState().buffers.s1!.messages[0]!;
  const noop = () => {};
  const view = render(<MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop} onAskUserListSubmit={noop} onAskUserCancel={noop} onAskUserReask={noop} />);
  expect(view.container.textContent).toContain(HARBOUR);
  expect(view.container.textContent).not.toContain("Pylos");
});
