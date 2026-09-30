import { unregisterErrorCardDom } from "./error-card-dom.js";
import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import type { ChatMessage } from "../../src/stores/chat-store.js";

afterEach(cleanup);
afterAll(unregisterErrorCardDom);
const noop = () => {};
const message: ChatMessage = {
  id: "failed-fixture", role: "assistant", content: "A partial answer.",
  parts: [{ kind: "text", text: "A partial answer." }], toolCalls: [],
  isStreaming: false, timestamp: 0,
  failure: { errorClass: "invalid_request", status: 400, message: "<img src=x onerror=alert(1)> **provider text**" },
};

test("a structured failure draws the approved card after partial output, with inert provider details", () => {
  const view = render(<MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop}
    onAskUserCancel={noop} onAskUserListSubmit={noop} closing />);
  expect(view.getByRole("region", { name: "Turn failed" })).toBeTruthy();
  expect(view.getByText("The provider rejected this request.")).toBeTruthy();
  expect(view.container.textContent).not.toContain("Error:");
  expect(view.container.textContent).toContain("A partial answer.");
  fireEvent.click(view.getByRole("button", { name: /Provider message/ }));
  expect(view.container.querySelectorAll("[data-turn-failure] img").length).toBe(0);
  expect(view.getByText(message.failure!.message)).toBeTruthy();
});
