// One copy control on every raw text block (#580): the run detail's raw trace
// and pruned rollup, a span event's payload, a tool's raw input and its
// clamped output. Each test clicks the control a person would and reads what
// reached the clipboard. Queries come from `render()`, never `screen` — see
// tests/render/dom.ts for why.
import { unregisterCopyControlDom } from "./copy-control-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ActivityRunDetail, ActivityRunRollup } from "@schlessera/brain-ui-sdk/protocol";

import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { SpanEventBlock } from "../../src/components/activity/span-bits.js";
import { ClampedPre, KeyValueView } from "../../src/components/chat/tool-views.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { COPY_OVERLAY_CLASS } from "../../src/components/chat/copy-button.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { useActivityStore } from "../../src/stores/activity-store.js";
import type { ToolCall } from "../../src/stores/chat-store.js";

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  useActivityStore.setState(useActivityStore.getInitialState(), true);
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
afterAll(unregisterCopyControlDom);

/** Replaces the clipboard with one that records every write. */
function mockClipboard(): string[] {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => void copied.push(value) },
  });
  return copied;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const rollup: ActivityRunRollup = {
  origin: "cron",
  name: "Nightly digest",
  sessionId: null,
  jobName: null,
  startedAt: 1,
  endedAt: 9,
  outcome: "success",
  durationMs: 8,
  spanCount: 2,
  costUsd: null,
  failureReason: null,
};

function renderRun(detail: ActivityRunDetail) {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json(detail) });
  const view = render(
    <BrainUiProvider root={root}>
      <RunDetail runId={detail.runId} onBack={() => {}} />
    </BrainUiProvider>
  );
  return { view, dispose: () => root.dispose() };
}

describe("the run detail", () => {
  test("the expanded raw trace copies exactly the serialised trace", async () => {
    const detail: ActivityRunDetail = {
      runId: "run-580",
      detailPruned: false,
      highWaterSeq: 0,
      rollup,
      spans: [
        { spanId: "run-580:turn", runId: "run-580", name: "turn", kind: "turn", origin: "cron", startedAt: 1, endedAt: 9, outcome: "success" },
        { spanId: "t1", runId: "run-580", parentSpanId: "run-580:turn", name: "execute_tool Write", toolName: "Write", kind: "tool", origin: "cron", startedAt: 2, endedAt: 8, outcome: "success" },
      ],
      events: [{ spanId: "t1", eventIndex: 0, ts: 3, eventType: "tool_input", payload: { path: "notes/field-notes.md" } }],
    };
    const copied = mockClipboard();
    const { view, dispose } = renderRun(detail);
    try {
      await act(flushPromises);
      expect(view.queryByRole("button", { name: "Copy raw trace" })).toBeNull();
      fireEvent.click(view.getByText("Raw trace"));
      fireEvent.click(view.getByRole("button", { name: "Copy raw trace" }));

      expect(copied).toHaveLength(1);
      expect(copied[0]).toBe(view.container.querySelector("pre")!.textContent!);
      // What the issue names: the whole trace, in the view's own serialisation.
      const parsed = JSON.parse(copied[0]!) as { runId: string; rollup: unknown; spans: unknown[]; events: unknown[] };
      expect(parsed.runId).toBe("run-580");
      expect(parsed.rollup).toEqual(rollup);
      expect(parsed.spans.map((s) => (s as { spanId: string }).spanId).sort()).toEqual(["run-580:turn", "t1"]);
      expect(parsed.events).toEqual(detail.events!);
      expect(copied[0]).toBe(JSON.stringify(parsed, null, 2));
      expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
    } finally {
      view.unmount();
      dispose();
    }
  });

  test("a pruned run copies its rollup", async () => {
    const copied = mockClipboard();
    const { view, dispose } = renderRun({ runId: "run-old", detailPruned: true, highWaterSeq: 0, rollup });
    try {
      await act(flushPromises);
      expect(view.container.textContent).toContain("Trace pruned");
      fireEvent.click(view.getByRole("button", { name: "Copy rollup" }));
      expect(copied).toEqual([JSON.stringify(rollup, null, 2)]);
    } finally {
      view.unmount();
      dispose();
    }
  });
});

test("a span event copies its whole payload, past the scrolled height", () => {
  const payload = { lines: Array.from({ length: 200 }, (_, i) => `line ${i}`) };
  const copied = mockClipboard();
  const view = render(<SpanEventBlock event={{ spanId: "t1", eventIndex: 0, ts: 1, eventType: "tool_output", payload }} />);
  fireEvent.click(view.getByRole("button", { name: "Copy payload" }));
  expect(copied).toEqual([JSON.stringify(payload, null, 2)]);
  expect(copied[0]).toContain("line 199");
});

test("a tool's raw input fallback copies the input JSON", () => {
  const inputJson = '{"partial": "input the parser never finished';
  const tool: ToolCall = { id: "tool-1", name: "Custom", input: {}, inputJson, status: "complete" };
  const copied = mockClipboard();
  const view = render(<KeyValueView tool={tool} />);
  fireEvent.click(view.getByRole("button", { name: "Copy input" }));
  expect(copied).toEqual([inputJson]);
});

describe("ClampedPre", () => {
  // Longer than the hard cap, so the rendering is clamped AND truncated.
  const text = Array.from({ length: 6000 }, (_, i) => `row ${i} of the output`).join("\n");

  test("copies the full text, not the clamped rendering", () => {
    const copied = mockClipboard();
    const view = render(<ClampedPre text={text} />);
    const pre = view.container.querySelector("pre")!;
    expect(pre.textContent!.length).toBeLessThan(text.length);
    expect(view.getByText(/^Show all/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Copy output" }));
    expect(copied).toEqual([text]);
  });

  test("inside the timeline, one control copies the output instead of two stacked", () => {
    const copied = mockClipboard();
    const tool: ToolCall = { id: "tool-2", name: "Bash", input: { command: "ls" }, inputJson: '{"command":"ls"}', status: "complete", output: text };
    const view = render(<ToolCallTimeline toolCalls={[tool]} onApproval={() => {}} live />);
    fireEvent.click(view.getByText("ls"));
    const buttons = view.getAllByRole("button", { name: "Copy output" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(copied).toEqual([text]);
  });
});

test("the overlay control reveals on hover, and is always visible on a coarse pointer", () => {
  const view = render(<ClampedPre text="short" />);
  const classes = view.getByRole("button", { name: "Copy output" }).className.split(" ");
  expect(classes).toContain("opacity-0");
  expect(classes).toContain("group-hover/copy:opacity-100");
  // The variant is compiled by Tailwind; tests/copy-button-css.test.ts checks
  // it becomes a `(pointer: coarse)` rule.
  expect(classes).toContain("pointer-coarse:opacity-100");
  expect(view.getByRole("button", { name: "Copy output" }).className).toBe(COPY_OVERLAY_CLASS);
});
