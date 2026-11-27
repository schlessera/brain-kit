import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { googleApproval } from "../fixtures/google-approval.js";
import { mount } from "./hit-reach-scene.js";
import { OWNED, edgeOwners, touchFloor } from "./hit-reach.js";

for (const width of [320, 1280]) test(`Google approval Allow and Deny own their reach at ${width}`, async ctx => {
  const scene = await mount(ctx, width, async () => { throw new Error("No approval lookup"); });
  const replies: unknown[] = [];
  const tools = (["gmail.draft.send", "gmail.modify"] as const).map((operation, index) => ({
    id: `google-${index}`, name: index ? "brain_google_gmail_modify" : "brain_google_gmail_send", status: "pending_approval" as const, approvalKind: "google" as const,
    inputJson: "", input: googleApproval(operation, index === 0),
  }));
  scene.draw(<div className="px-4 md:px-6"><ToolCallTimeline live toolCalls={tools} onApproval={(...args) => { replies.push(args); }} /></div>);
  const buttons = [...scene.host.querySelectorAll<HTMLElement>("[data-kit-approval-actions] [role=button]")];
  expect(buttons).toHaveLength(4);
  for (const button of buttons) {
    button.scrollIntoView({ block: "center" });
    expect(touchFloor(button)).toBe("met");
    expect(edgeOwners(button, 44)).toEqual(OWNED);
  }
  await userEvent.click(page.getByRole("button", { name: /^Send email/ }));
  await userEvent.click(buttons[3]!);
  expect(replies).toEqual([["google-0", true, undefined], ["google-1", false, undefined]]);
});
