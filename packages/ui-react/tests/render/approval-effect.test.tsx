// A destructive-command approval says what the command will do (#112): the
// matched confirm pattern's effect reaches the card as the request's
// description, and both places a pending approval is drawn show it. Same
// containment contract as render-smoke.test.tsx: the DOM module first,
// `afterAll(unregisterDom)`, queries off `render()` and never `screen`.
import { unregisterApprovalEffectDom as unregisterDom } from "./approval-effect-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ApprovalCard } from "../../src/components/activity/approval-card.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import type { ToolCall } from "../../src/stores/chat-store.js";

afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregisterDom();
});

const EFFECT = "delete a directory and everything inside it";

function pending(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "t1",
    name: "Bash",
    input: { command: "rm -rf notes/old" },
    inputJson: '{"command":"rm -rf notes/old"}',
    status: "pending_approval",
    approvalKind: "command",
    approvalDescription: EFFECT,
    ...overrides,
  };
}

describe("the effect of a confirmed command, on the card", () => {
  test("the Actions-pane card shows it", () => {
    const view = render(
      <ApprovalCard tool={pending()} origin="this conversation" keys={false} onDecide={() => {}} />
    );
    const card = view.getByRole("group", { name: "Approval: Bash" });
    expect(card.textContent).toContain(EFFECT);
  });

  test("the transcript's card shows it", () => {
    const view = render(<ToolCallTimeline toolCalls={[pending()]} onApproval={() => {}} />);
    const panel = view.container.textContent ?? "";
    expect(panel).toContain(EFFECT);
  });

  test("a tool grant shows no line: its description is the runtime's, not an effect", () => {
    const grant = pending({
      name: "mcp__external__publish",
      input: { id: 7 },
      inputJson: '{"id":7}',
      approvalKind: "tool",
      approvalDescription: 'Tool "mcp__external__publish" is not auto-allowed in this deployment.',
    });
    const card = render(
      <ApprovalCard tool={grant} origin="this conversation" keys={false} onDecide={() => {}} />
    );
    expect(card.container.textContent).not.toContain("not auto-allowed");
    cleanup();
    const transcript = render(<ToolCallTimeline toolCalls={[grant]} onApproval={() => {}} />);
    expect(transcript.container.textContent).not.toContain("not auto-allowed");
  });

  test("once decided, the transcript no longer shows it, even with the details open", () => {
    // Pending first, so the line is on screen; then decided, and the details
    // reopened by hand — the entry collapses on a decision, and a collapsed
    // entry would hide the line whether or not the pending guard held.
    const view = render(<ToolCallTimeline live toolCalls={[pending()]} onApproval={() => {}} />);
    expect(view.container.textContent ?? "").toContain(EFFECT);

    view.rerender(
      <ToolCallTimeline live toolCalls={[pending({ status: "approved" })]} onApproval={() => {}} />
    );
    const header = view.container.querySelector("button");
    if (!header) throw new Error("no entry header to reopen the details with");
    fireEvent.click(header);
    // The details are open: the tool's input is drawn again.
    expect(view.container.textContent ?? "").toContain("rm -rf notes/old");
    expect(view.container.textContent ?? "").not.toContain(EFFECT);
  });
});
