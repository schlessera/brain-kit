// The tool rows of a streaming answer (#4748). The chat store keeps a tool
// call's object identity until that call changes, so a frame that only grows
// the answer's text must re-render no completed row and parse no output
// again; a call replaced by a new object, or a span whose timing moved, must
// still redraw its row. Props-only, keyless, mounted in happy-dom. Queries
// come from `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterToolRowsDom } from "./tool-rows-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { z } from "zod";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
import { defineToolComponentContract } from "@schlessera/brain-ui-sdk/tool-contracts";

import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { bind } from "../../src/components/chat/renderers/bind.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ChatMessage, ToolCall } from "../../src/stores/chat-store.js";
import { countSafeParse } from "../safe-parse-counter.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const r of roots.splice(0)) r.dispose();
});
afterAll(unregisterToolRowsDom);

const SESSION = "odysseus-ithaca";
const UPDATES = 20;
const noop = () => {};
// Stable across renders, as ChatPage's useCallback handlers are: the memo
// contract of MessageBubble and of each row rests on it.
const handlers = {
  onToolApproval: noop,
  onAskUserSubmit: noop,
  onAskUserCancel: noop,
  onAskUserListSubmit: noop,
};

function makeRoot(): BrainUiRoot {
  const r = createBrainUiRoot({
    storage: null,
    request: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  });
  r.stores.chat.setState({ activeSessionId: SESSION, backendIds: { [SESSION]: "claude" } });
  roots.push(r);
  return r;
}

function tool(id: string, name: string, output: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input: {}, inputJson: "{}", output, status: "complete", ...extra };
}

/** A streaming answer: its tool calls first, then the text that is still growing. */
function streaming(toolCalls: ToolCall[], text: string): ChatMessage {
  return {
    id: "answer-1",
    role: "assistant",
    content: text,
    toolCalls,
    parts: [...toolCalls.map((_, toolIndex) => ({ kind: "tool" as const, toolIndex })), { kind: "text", text }],
    isStreaming: true,
    timestamp: 0,
    turnId: "turn-1",
  };
}

function mount(r: BrainUiRoot, message: ChatMessage) {
  const ui = (m: ChatMessage) => (
    <BrainUiProvider root={r}>
      <MessageBubble message={m} {...handlers} />
    </BrainUiProvider>
  );
  const view = render(ui(message));
  return { view, update: (m: ChatMessage) => view.rerender(ui(m)) };
}

/** The activity stream's span for one tool call, server-stamped. */
function seedSpan(r: BrainUiRoot, toolUseId: string, startedAt: number, endedAt: number) {
  const span = {
    spanId: toolUseId, runId: "run-1", name: `tool:${toolUseId}`, kind: "tool", origin: "session",
    sessionId: SESSION, startedAt, endedAt,
  } as ActivitySpan;
  r.stores.activity.setState((s) => ({
    spanRun: { ...s.spanRun, [toolUseId]: "run-1" },
    spans: { ...s.spans, "run-1": { ...s.spans["run-1"], [toolUseId]: span } },
  }));
}

describe("a streaming answer's completed tool rows", () => {
  test("do not re-render while only the answer's text grows", () => {
    const r = makeRoot();
    let summaries = 0;
    r.renderers.register({
      renderers: [{
        match: "chart_course",
        summary: (t) => {
          summaries++;
          return `leg ${t.id}`;
        },
      }],
    });
    const calls = Array.from({ length: 10 }, (_, i) => tool(`leg-${i}`, "chart_course", `bearing ${i}`));
    const { view, update } = mount(r, streaming(calls, "Ithaca"));
    expect(view.container.textContent).toContain("leg leg-9");
    expect(summaries).toBe(10);
    for (let i = 1; i <= UPDATES; i++) {
      act(() => update(streaming(calls, `Ithaca${" lies west".repeat(i)}`)));
    }
    expect(view.container.textContent).toContain(" lies west".repeat(UPDATES));
    expect(summaries).toBe(10);
  });

  test("a row whose activity span moves still updates its duration", () => {
    const r = makeRoot();
    seedSpan(r, "read-1", 1_000, 3_000);
    const calls = [tool("read-1", "Read", "line one\nline two")];
    const { view } = mount(r, streaming(calls, "Penelope waits"));
    const meta = () => view.container.querySelector('[data-tool-call="read-1"]')?.textContent ?? "";
    expect(meta()).toContain("2 lines");
    const before = meta();
    act(() => seedSpan(r, "read-1", 1_000, 9_000));
    expect(meta()).not.toBe(before);
    expect(meta()).toContain("2 lines");
  });
});

describe("a bound renderer's payload", () => {
  const VOYAGE = defineToolComponentContract({
    name: "plot_voyage",
    description: "Plot a leg of the voyage home.",
    input: z.object({}),
    brief: (visible) => `${visible}: plot a leg.`,
    payload: z.object({ from: z.string(), to: z.string() }),
  });
  const pack = {
    renderers: bind(VOYAGE, ({ from, to }) => <p data-voyage="">{`${from} to ${to}`}</p>, {
      summary: (payload) => `from ${payload.from}`,
      meta: (payload) => `to ${payload.to}`,
    }),
  };
  const leg = (from: string, to: string) => tool("voyage-1", "plot_voyage", JSON.stringify({ from, to }));

  test("is parsed once for a row's header and output, and not again while the text grows", () => {
    const r = makeRoot();
    r.renderers.register(pack);
    seedSpan(r, "voyage-1", 1_000, 4_000);
    const parse = countSafeParse(VOYAGE.payload);
    try {
      const calls = [leg("Troy", "Ithaca")];
      const { view, update } = mount(r, streaming(calls, "Setting sail"));
      act(() => {
        fireEvent.click(view.getByText("from Troy"));
      });
      expect(view.container.querySelector("[data-voyage]")?.textContent).toBe("Troy to Ithaca");
      expect(view.container.textContent).toContain("to Ithaca");
      expect(parse.calls).toBe(1);
      for (let i = 1; i <= UPDATES; i++) {
        act(() => update(streaming(calls, `Setting sail${" past Scylla".repeat(i)}`)));
      }
      expect(view.container.querySelector("[data-voyage]")?.textContent).toBe("Troy to Ithaca");
      expect(parse.calls).toBe(1);
    } finally {
      parse.restore();
    }
  });

  test("a call replaced by a new object with a new output redraws its row from the new output", () => {
    const r = makeRoot();
    r.renderers.register(pack);
    const parse = countSafeParse(VOYAGE.payload);
    try {
      const { view, update } = mount(r, streaming([leg("Troy", "Ismarus")], "Setting sail"));
      act(() => {
        fireEvent.click(view.getByText("from Troy"));
      });
      expect(view.container.querySelector("[data-voyage]")?.textContent).toBe("Troy to Ismarus");
      const parsedBefore = parse.calls;
      // A replay or a result hands the store a new object with the same id.
      act(() => update(streaming([leg("Aeaea", "Ithaca")], "Setting sail again")));
      expect(view.container.textContent).toContain("from Aeaea");
      expect(view.container.textContent).toContain("to Ithaca");
      expect(view.container.querySelector("[data-voyage]")?.textContent).toBe("Aeaea to Ithaca");
      expect(parse.calls).toBe(parsedBefore + 1);
    } finally {
      parse.restore();
    }
  });
});
