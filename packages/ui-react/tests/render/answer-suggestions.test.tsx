// Answer suggestions (#40, D50): the follow-ups the model offers under its own
// answer, drawn as the turn's closing row, taken into the composer and never
// sent. Mounted as the app mounts them — the real ChatPage and Composer on a
// root with a fake socket — so what is asserted is the page, not a predicate.
//
// Every suppression rule is asserted twice: once on a turn built from live
// frames, once on the same turn replayed from `session_history`, with the
// same assertion. The ruling on #40 is that replay draws exactly what live
// drew, so a rule that only held live would be a failing test here.
import { unregisterAnswerSuggestionsDom } from "./answer-suggestions-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";
import {
  SHOW_BLOCK_CONTRACT,
  visibleToolName,
  type Block,
} from "@schlessera/brain-ui-sdk/client";
import type { MessageSource, SessionHistoryMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";

import { ChatPage } from "../../src/components/chat/chat-page.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import {
  endsWithQuestion,
  insertSuggestion,
  keptSuggestions,
  visibleSuggestions,
} from "../../src/lib/answer-suggestions.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";
import { SUGGESTIONS } from "../block-fixtures.js";

// happy-dom rejects an animation's `finished` promise when a message
// unmounts mid-animation, and the rejection fails whichever test is running.
// These tests are about what the transcript draws, not the animation engine,
// so motion elements are plain DOM wrappers, as in render-smoke.test.tsx.
const motionElements = new Map<string, ReturnType<typeof motionElement>>();
function motionElement(tag: string) {
  return forwardRef<HTMLElement, Record<string, unknown>>(
    ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) =>
      createElement(tag, { ...props, ref })
  );
}
mock.module("framer-motion", () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const existing = motionElements.get(tag);
        if (existing) return existing;
        const element = motionElement(tag);
        motionElements.set(tag, element);
        return element;
      },
    }
  ),
}));

afterEach(cleanup);
afterAll(unregisterAnswerSuggestionsDom);

const SESSION = "s-40";
const SHOW_BLOCK = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
const ANSWER = "Circe warned you on day 2,871: keep close to Scylla's cliff and lose six rather than all.";
const PROMPT = "What did Circe say about the strait?";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url = "") {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  globalThis.fetch = (async () =>
    Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

interface Page {
  root: BrainUiRoot;
  socket: FakeSocket;
  view: ReturnType<typeof render>;
  deliver: (...frames: unknown[]) => void;
  group: () => HTMLElement | null;
  /** Whether the row is in the DOM at all — absent, not hidden by CSS. */
  shown: () => boolean;
  chips: () => HTMLButtonElement[];
  field: () => HTMLTextAreaElement;
  type: (value: string) => void;
  /** Every frame this client sent that could start or answer a turn. */
  turnFrames: () => unknown[];
  done: () => void;
}

async function mount(): Promise<Page> {
  const root = createBrainUiRoot({ storage: null });
  const release = root.connection.connect();
  const socket = FakeSocket.instances.at(-1)!;
  act(() => {
    socket.open();
    root.stores.chat.getState().setActiveSession(SESSION);
  });
  const view = render(
    <BrainUiProvider root={root}>
      <ChatPage />
    </BrainUiProvider>
  );
  await tick();
  const page: Page = {
    root,
    socket,
    view,
    deliver: (...frames) =>
      act(() => {
        for (const frame of frames) socket.deliver({ sessionId: SESSION, ...(frame as object) });
        root.connection.flushChatDeltas();
      }),
    group: () => view.container.querySelector<HTMLElement>('[role="group"][aria-label="Suggested follow-ups"]'),
    shown: () => page.group() !== null,
    chips: () => [...view.container.querySelectorAll<HTMLButtonElement>("[data-answer-suggestions] button")],
    field: () => view.container.querySelector("textarea")!,
    type: (value) => {
      // happy-dom's value tracker does not drive React's synthetic onChange
      // in this harness (render-smoke.test.tsx, `changeControlledInput`), so
      // the mounted field's own prop is called: the composer still owns the
      // state change and every effect after it.
      const field = page.field();
      field.focus();
      const propsKey = Object.keys(field).find((key) => key.startsWith("__reactProps$"))!;
      const props = (field as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
      act(() => props.onChange({ target: { value } }));
    },
    turnFrames: () =>
      socket.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((frame) => frame.type === "chat_message" || frame.type === "ask_user_response"),
    done: () => {
      view.unmount();
      release();
      root.dispose();
    },
  };
  return page;
}

// ---------------------------------------------------------------------------
// Building one turn, live or replayed, from the same description
// ---------------------------------------------------------------------------

interface Turn {
  failure?: TurnFailure;
  prompt?: string;
  source?: MessageSource;
  text?: string;
  /** A block, or a raw tool output string (a rejection, or JSON as written). */
  calls?: Array<Block | string>;
  /** An ask_user exchange in the turn, and whether it was answered. */
  askUser?: "pending" | "answered";
  /** Leave the turn running (live only; a replayed turn has ended). */
  running?: boolean;
}

function toolOutput(call: Block | string): { output: string; isError: boolean } {
  if (typeof call !== "string") return { output: JSON.stringify({ block: call }), isError: false };
  return { output: call, isError: !call.trimStart().startsWith("{") };
}

const QUESTIONS = [
  {
    question: "Which crossing?",
    header: "Crossing",
    multiSelect: false,
    options: [
      { label: "Scylla", description: "lose six" },
      { label: "Charybdis", description: "lose all" },
    ],
  },
];

function liveTurn(page: Page, turn: Turn): void {
  act(() => {
    const chat = page.root.stores.chat.getState();
    chat.addUserMessage(SESSION, turn.prompt ?? PROMPT, turn.source ?? "typed");
    chat.startAssistantMessage(SESSION);
  });
  page.deliver({ type: "status", status: "thinking" }, { type: "text_delta", text: turn.text ?? ANSWER });
  if (turn.askUser) {
    page.deliver(
      { type: "tool_use_start", toolUseId: "q1", toolName: "mcp__brain-ui__ask_user" },
      { type: "tool_use_complete", toolUseId: "q1", toolName: "mcp__brain-ui__ask_user", input: { questions: QUESTIONS } },
      { type: "ask_user_request", requestId: "q1", questions: QUESTIONS }
    );
    if (turn.askUser === "answered") {
      act(() => page.root.stores.chat.getState().submitAskUserAnswers(SESSION, "q1", { "Which crossing?": "Scylla" }));
      page.deliver({ type: "tool_result", toolUseId: "q1", output: JSON.stringify({ answers: { "Which crossing?": "Scylla" } }), isError: false });
    }
  }
  (turn.calls ?? []).forEach((call, i) => {
    const input = typeof call === "string" ? {} : { block: call };
    page.deliver(
      { type: "tool_use_start", toolUseId: `b${i}`, toolName: SHOW_BLOCK },
      { type: "tool_use_complete", toolUseId: `b${i}`, toolName: SHOW_BLOCK, input },
      { type: "tool_result", toolUseId: `b${i}`, ...toolOutput(call) }
    );
  });
  if (!turn.running) page.deliver({ type: "result", outcome: turn.failure ? "error" : "success", isError: Boolean(turn.failure), numTurns: 1, durationMs: 1, failure: turn.failure }, { type: "status", status: "idle" });
}

function historyOf(turn: Turn): SessionHistoryMessage[] {
  const toolCalls: SessionHistoryMessage["toolCalls"] = [];
  const parts: NonNullable<SessionHistoryMessage["parts"]> = [{ kind: "text", text: turn.text ?? ANSWER }];
  if (turn.askUser) {
    toolCalls.push({
      id: "q1",
      name: "mcp__brain-ui__ask_user",
      input: { questions: QUESTIONS },
      ...(turn.askUser === "answered" ? { output: JSON.stringify({ answers: { "Which crossing?": "Scylla" } }) } : {}),
    });
    parts.push({ kind: "tool", toolIndex: toolCalls.length - 1 });
  }
  (turn.calls ?? []).forEach((call, i) => {
    toolCalls.push({ id: `b${i}`, name: SHOW_BLOCK, input: typeof call === "string" ? {} : { block: call }, ...toolOutput(call) });
    parts.push({ kind: "tool", toolIndex: toolCalls.length - 1 });
  });
  return [
    // `source` is how the message was spoken; ui-server replays it (#549).
    { role: "user", content: turn.prompt ?? PROMPT, toolCalls: [], ...(turn.source ? { source: turn.source } : {}) } as SessionHistoryMessage,
    { role: "assistant", content: turn.text ?? ANSWER, toolCalls, parts, ...(turn.failure ? { failure: turn.failure } : {}) },
  ];
}

/**
 * A resume as the server sends it (`packages/ui-server/src/ws/dispatch.ts`,
 * `session_resume`): the history, then the session's status — idle when it
 * is loaded, thinking when a turn is still running on it.
 */
function replayTurn(page: Page, turn: Turn, extra: SessionHistoryMessage[] = []): void {
  page.deliver(
    { type: "session_history", messages: [...historyOf(turn), ...extra] },
    turn.running
      ? { type: "status", status: "thinking", detail: "Session in progress" }
      : { type: "status", status: "idle", detail: "Session loaded" }
  );
}

const MODES = [
  ["live", liveTurn],
  ["replayed", replayTurn],
] as const;

// ---------------------------------------------------------------------------
// The row itself
// ---------------------------------------------------------------------------

for (const [mode, build] of MODES) {
  describe(`the closing row · ${mode}`, () => {
    test("draws the chips under the finished answer, after the text, as real buttons", async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        const group = page.group();
        expect(group).not.toBeNull();
        expect(page.chips().map((chip) => chip.textContent)).toEqual([
          "What did Circe say about Charybdis?",
          "Who was on watch then?",
        ]);
        for (const chip of page.chips()) expect(chip.getAttribute("type")).toBe("button");
        // The label: the default when the payload gives none, hidden from
        // the accessibility tree because the group's name already says it.
        expect(group!.textContent).toContain("Ask next");
        const text = page.view.container.textContent ?? "";
        expect(text.indexOf("lose six rather than all")).toBeLessThan(text.indexOf("Ask next"));
        // Its call position draws nothing: no empty block, no trace step.
        expect(page.view.container.querySelector('[data-block="suggestions"]') === null).toBe(true);
      } finally {
        page.done();
      }
    });

    test("the payload's own label replaces the default", async () => {
      const page = await mount();
      try {
        build(page, { calls: [{ ...SUGGESTIONS, label: "Then ask" }] });
        expect(page.group()!.textContent).toContain("Then ask");
        expect(page.group()!.textContent).not.toContain("Ask next");
      } finally {
        page.done();
      }
    });

    test("stored extra fields are discarded while otherwise valid suggestions still render", async () => {
      const page = await mount();
      const raw = JSON.stringify({ block: { kind: "suggestions", extra: "block-sentinel", items: [{ label: "Who was on watch then?", tone: "amber" }] } });
      try {
        expect(raw).toContain("block-sentinel");
        expect(raw).toContain("amber");
        build(page, { calls: [raw] });
        expect(page.chips().map(chip => chip.textContent)).toEqual(["Who was on watch then?"]);
        expect(page.group()!.textContent).not.toContain("block-sentinel");
        expect(page.group()!.textContent).not.toContain("amber");
        expect(page.turnFrames()).toEqual([]);
      } finally { page.done(); }
    });

    test("malformed stored suggestions keep their generic trace fallback", async () => {
      const page = await mount();
      const raw = JSON.stringify({ block: { kind: "suggestions", extra: "block-sentinel", items: [{ label: "x", tone: "amber" }] } });
      try {
        build(page, { calls: [raw] });
        expect(page.shown()).toBe(false);
        fireEvent.click(page.view.getByRole("button", { name: /1 step/ }));
        fireEvent.click(page.view.getByRole("button", { name: "Block" }));
        expect(page.view.container.textContent).toContain('"kind":"suggestions"');
        expect(page.turnFrames()).toEqual([]);
      } finally { page.done(); }
    });

    test("the last valid call in the turn wins", async () => {
      const page = await mount();
      try {
        build(page, {
          calls: [
            { kind: "suggestions", items: [{ label: "An earlier idea" }] },
            SUGGESTIONS,
            // Rejected by the server: stays in the trace, does not win.
            "block.items: Too big: expected array to have <=2 items",
          ],
        });
        expect(page.chips().map((chip) => chip.textContent)).toEqual([
          "What did Circe say about Charybdis?",
          "Who was on watch then?",
        ]);
      } finally {
        page.done();
      }
    });

    test("accessible names: the group, each chip by its words, and what it does", async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        const chip = page.view.getByRole("button", { name: "Who was on watch then?" });
        const described = page.view.container.querySelector(`#${CSS.escape(chip.getAttribute("aria-describedby")!)}`);
        expect(described?.textContent).toBe("Puts this in the composer to edit. Does not send.");
        expect(page.view.getByRole("group", { name: "Suggested follow-ups" })).toBeTruthy();
      } finally {
        page.done();
      }
    });
  });
}

describe("the welcome chips", () => {
  test("stay the kit's, app-chosen, under their own label, and are not a closing row", async () => {
    const page = await mount();
    try {
      const text = page.view.container.textContent ?? "";
      expect(text).toContain("Start with");
      expect(text).toContain("What's new?");
      expect(page.shown()).toBe(false);
      // The kit's chip is a pressable span; only the answer row draws <button>s.
      const welcome = page.view.getByText("What's new?").closest('[role="button"]');
      expect(welcome?.tagName).toBe("SPAN");
    } finally {
      page.done();
    }
  });
});

// ---------------------------------------------------------------------------
// Suppression: S1–S9, each live and replayed with the same assertion
// ---------------------------------------------------------------------------

describe("suppression", () => {
  for (const [mode, build] of MODES) {
    test(`S2 · ${mode}: a failed turn suppresses nonempty suggestions`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        expect(page.shown()).toBe(true);
        expect(page.chips()).toHaveLength(2);
        act(() => page.root.stores.chat.getState().setMessages(SESSION, []));
        build(page, { calls: [SUGGESTIONS], failure: { errorClass: "server_error", message: "Provider failed" } });
        expect(page.shown()).toBe(false);
        expect(page.view.getByRole("region", { name: "Turn failed" })).toBeTruthy();
      } finally { page.done(); }
    });

    test(`S3 · ${mode}: a question in the turn still waiting on the reader`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS], askUser: "pending" });
        expect(page.shown()).toBe(false);
      } finally {
        page.done();
      }
      // The control: the same turn with the question answered does draw.
      const answered = await mount();
      try {
        build(answered, { calls: [SUGGESTIONS], askUser: "answered" });
        expect(answered.shown()).toBe(true);
      } finally {
        answered.done();
      }
    });

    test(`S4 · ${mode}: an answer that ends by asking the reader something`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS], text: "Scylla or Charybdis — which would you choose?" });
        expect(page.shown()).toBe(false);
      } finally {
        page.done();
      }
    });

    test(`S5 · ${mode}: hidden while voice holds the composer, back when it is idle`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        expect(page.shown()).toBe(true);
        act(() => page.root.stores.voice.getState().setMode("dictate"));
        expect(page.shown()).toBe(false);
        act(() => page.root.stores.voice.getState().setMode("idle"));
        expect(page.shown()).toBe(true);
      } finally {
        page.done();
      }
    });

    test(`S6 · ${mode}: hidden while voice text waits for review, back after it clears`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        act(() => page.root.stores.voice.getState().setReviewText("and the winds"));
        expect(page.shown()).toBe(false);
        act(() => page.root.stores.voice.getState().clearReview());
        expect(page.shown()).toBe(true);
      } finally {
        page.done();
      }
    });

    test(`S7 · ${mode}: a later user message flips the row away for good`, async () => {
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS] });
        expect(page.shown()).toBe(true);
        if (mode === "live") {
          act(() => page.root.stores.chat.getState().addUserMessage(SESSION, "Who was on watch then?", "typed"));
        } else {
          replayTurn(page, { calls: [SUGGESTIONS] }, [{ role: "user", content: "Who was on watch then?", toolCalls: [] }]);
        }
        expect(page.shown()).toBe(false);
        // A later turn that errors, or ends with no suggestions, does not
        // bring the earlier row back.
        if (mode === "live") {
          act(() => page.root.stores.chat.getState().startAssistantMessage(SESSION));
          page.deliver({ type: "text_delta", text: "The API failed." }, { type: "result", outcome: "error" });
        }
        expect(page.chips()).toEqual([]);
      } finally {
        page.done();
      }
    });

    test(`S8 · ${mode}: a rejected call draws no row and keeps its trace fallback`, async () => {
      const page = await mount();
      try {
        build(page, { calls: ["block.items: Too big: expected array to have <=2 items"] });
        expect(page.shown()).toBe(false);
        // The trace keeps the rejected call, where its fallback says why.
        expect(page.view.container.textContent).toContain("1 failed");
      } finally {
        page.done();
      }
    });

    test(`S8 · ${mode}: every item dropped draws nothing, and no error`, async () => {
      const page = await mount();
      try {
        build(page, {
          calls: [{ kind: "suggestions", items: [{ label: "Tell me more." }, { label: PROMPT }] }],
        });
        expect(page.shown()).toBe(false);
      } finally {
        page.done();
      }
    });

    test(`S9 · ${mode}: a turn spoken in a voice conversation`, async () => {
      // Live, the source is on the store's message. Replayed, it is the
      // user message's `source` in the history, which ui-server keeps (#549).
      const page = await mount();
      try {
        build(page, { calls: [SUGGESTIONS], source: "voice-conversation" });
        expect(page.shown()).toBe(false);
      } finally {
        page.done();
      }
      const dictated = await mount();
      try {
        build(dictated, { calls: [SUGGESTIONS], source: "voice-dictate" });
        expect(dictated.shown()).toBe(true);
      } finally {
        dictated.done();
      }
    });
  }

  test("S1 · live: nothing while the turn runs, even with the call already in", async () => {
    const page = await mount();
    try {
      liveTurn(page, { calls: [SUGGESTIONS], running: true });
      expect(page.shown()).toBe(false);
      page.deliver({ type: "result", outcome: "success" }, { type: "status", status: "idle" });
      expect(page.shown()).toBe(true);
    } finally {
      page.done();
    }
  });

  test("S1 · replayed: a reattach mid-turn keeps the row hidden until the turn ends", async () => {
    const page = await mount();
    try {
      replayTurn(page, { calls: [SUGGESTIONS], running: true });
      expect(page.shown()).toBe(false);
      page.deliver({ type: "status", status: "idle" });
      expect(page.shown()).toBe(true);
    } finally {
      page.done();
    }
  });

  test("not suppressed: a cancelled turn that reached the call", async () => {
    const page = await mount();
    try {
      liveTurn(page, { calls: [SUGGESTIONS], running: true });
      page.deliver({ type: "status", status: "cancelled" }, { type: "result", outcome: "cancelled" });
      expect(page.shown()).toBe(true);
    } finally {
      page.done();
    }
  });

  test("a replay delivered in chunks decides on the whole transcript", async () => {
    const page = await mount();
    try {
      replayTurn(page, { calls: [SUGGESTIONS] });
      expect(page.shown()).toBe(true);
      page.deliver(
        { type: "session_history", append: true, messages: [{ role: "user", content: "Next question", toolCalls: [] }] },
        { type: "status", status: "idle", detail: "Session loaded" }
      );
      expect(page.shown()).toBe(false);
    } finally {
      page.done();
    }
  });
});

// ---------------------------------------------------------------------------
// Taking a chip: the composer, never the socket
// ---------------------------------------------------------------------------

describe("taking a chip", () => {
  async function ready(): Promise<Page> {
    const page = await mount();
    liveTurn(page, { calls: [SUGGESTIONS] });
    expect(page.shown()).toBe(true);
    return page;
  }

  const take = async (page: Page, index: number) => {
    act(() => {
      fireEvent.click(page.chips()[index]!);
    });
    await tick();
  };

  test("into an empty composer: the words, focus in the field, caret at the end, nothing sent", async () => {
    const page = await ready();
    try {
      const before = page.turnFrames().length;
      await take(page, 1);
      const field = page.field();
      expect(field.value).toBe("Who was on watch then?");
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(field.value.length);
      expect(field.selectionEnd).toBe(field.value.length);
      expect(page.turnFrames().length).toBe(before);
      expect(page.view.container.querySelector("[data-composer-notice]")?.textContent).toBe("Added to the composer");
      // The row stays until the reader sends something.
      expect(page.shown()).toBe(true);
    } finally {
      page.done();
    }
  });

  test("below a draft: the draft kept byte for byte, the words on their own line", async () => {
    const page = await ready();
    try {
      page.type("and check the winds  ");
      await take(page, 1);
      expect(page.field().value).toBe("and check the winds  \nWho was on watch then?");
      expect(page.view.container.querySelector("[data-composer-notice]")?.textContent).toBe("Added below your draft");
      expect(page.turnFrames()).toEqual([]);
    } finally {
      page.done();
    }
  });

  test("the same chip twice adds it once; both chips stack in order", async () => {
    const page = await ready();
    try {
      page.type("D");
      await take(page, 0);
      await take(page, 0);
      expect(page.field().value).toBe("D\nWhat did Circe say about Charybdis?");
      await take(page, 1);
      expect(page.field().value).toBe("D\nWhat did Circe say about Charybdis?\nWho was on watch then?");
    } finally {
      page.done();
    }
  });

  test("a command draft keeps its text and closes the palette", async () => {
    const page = await ready();
    try {
      page.type("/wh");
      expect(page.view.container.textContent).toContain("/wh");
      // "/wh" filters the palette down to /whatsup, the daily briefing.
      const paletteOpen = () => (page.view.container.textContent ?? "").includes("Daily briefing");
      expect(paletteOpen()).toBe(true);
      await take(page, 1);
      expect(page.field().value).toBe("/wh\nWho was on watch then?");
      expect(paletteOpen()).toBe(false);
    } finally {
      page.done();
    }
  });

  test("offline: the words go in, the draft is kept, Send stays disabled", async () => {
    const page = await ready();
    try {
      act(() => page.socket.close(1006));
      await tick();
      await take(page, 1);
      expect(page.field().value).toBe("Who was on watch then?");
      expect(page.view.getByRole("button", { name: "Send — unavailable" }).getAttribute("aria-disabled")).toBe("true");
      expect(page.turnFrames()).toEqual([]);
    } finally {
      page.done();
    }
  });

  test("Enter and Space on a focused chip fill the composer and submit nothing", async () => {
    const page = await ready();
    try {
      const chip = page.chips()[1]!;
      chip.focus();
      // A real <button> turns Enter and Space into a click; happy-dom does
      // not synthesise that, so the click is what is dispatched here and the
      // element type is what is asserted.
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.getAttribute("type")).toBe("button");
      fireEvent.keyDown(chip, { key: "Enter" });
      await take(page, 1);
      expect(page.field().value).toBe("Who was on watch then?");
      expect(page.turnFrames()).toEqual([]);
    } finally {
      page.done();
    }
  });

  test("sending afterwards is the ordinary composer send, and it flips the row", async () => {
    const page = await ready();
    try {
      await take(page, 1);
      page.type(`${page.field().value} and who slept`);
      act(() => {
        fireEvent.keyDown(page.field(), { key: "Enter" });
      });
      await tick();
      const sent = page.turnFrames() as Array<{ type: string; text?: string }>;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "chat_message", text: "Who was on watch then? and who slept" });
      expect(page.shown()).toBe(false);
    } finally {
      page.done();
    }
  });
});

// ---------------------------------------------------------------------------
// The pure rules the page is built on
// ---------------------------------------------------------------------------

describe("the rules", () => {
  // The page only mounts the row for the session's last message (ChatPage's
  // `closing`), so the page tests above cannot tell whether the decision
  // ITSELF holds S7. This does: the same message, last and not last.
  test("S7 in the decision itself: only the session's last message draws", () => {
    const answer = {
      id: "a",
      role: "assistant",
      content: ANSWER,
      parts: [{ kind: "text", text: ANSWER }, { kind: "tool", toolIndex: 0 }],
      toolCalls: [
        { id: "b0", name: SHOW_BLOCK, input: {}, inputJson: "{}", output: JSON.stringify({ block: SUGGESTIONS }), status: "complete" },
      ],
      isStreaming: false,
      timestamp: 0,
    } as ChatMessage;
    const next = { ...answer, id: "u", role: "user", content: "Next", parts: [], toolCalls: [] } as ChatMessage;
    const context = { running: false, voiceMode: "idle", voiceReviewPending: false } as const;
    expect(visibleSuggestions(answer, { ...context, messages: [answer] })).toHaveLength(2);
    expect(visibleSuggestions(answer, { ...context, messages: [answer, next] })).toEqual([]);
  });

  test("drops: duplicates, the reader's own question, and filler", () => {
    const keep = (labels: string[], prompt?: string) =>
      keptSuggestions({ kind: "suggestions", items: labels.map((label) => ({ label })) }, prompt).map((i) => i.label);
    expect(keep(["Who steered?", "who steered"])).toEqual(["Who steered?"]);
    expect(keep(["Who steered?", "What did Circe say?"], "what did circe say")).toEqual(["Who steered?"]);
    for (const filler of ["Tell me more", "tell me more.", "Anything else?", "Can you elaborate?", "What else?!"]) {
      expect(keep([filler])).toEqual([]);
    }
    // Filler is exact, not a prefix: a grounded follow-up that starts the same way stays.
    expect(keep(["Tell me more about the Cyclops"])).toEqual(["Tell me more about the Cyclops"]);
  });

  test("a question at the end, through closing quotes and emphasis", () => {
    const message = (text: string) =>
      ({ parts: [{ kind: "text", text }] }) as Parameters<typeof endsWithQuestion>[0];
    expect(endsWithQuestion(message("Which would you choose?"))).toBe(true);
    expect(endsWithQuestion(message("**Which would you choose?**\n"))).toBe(true);
    expect(endsWithQuestion(message('She asked, "why?"'))).toBe(true);
    expect(endsWithQuestion(message("Why? Because the winds turned."))).toBe(false);
  });

  test("insert: empty, below a draft, already there, after a trailing newline", () => {
    expect(insertSuggestion("", "Who?!")).toBe("Who?!");
    expect(insertSuggestion("   ", "Who?!")).toBe("Who?!");
    expect(insertSuggestion("D", "Who?!")).toBe("D\nWho?!");
    expect(insertSuggestion("D\n", "Who?!")).toBe("D\nWho?!");
    expect(insertSuggestion("D\n  Who?!  ", "Who?!")).toBe("D\n  Who?!  ");
  });
});
